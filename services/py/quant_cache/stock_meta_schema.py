"""Pyarrow schema + codec for ``StockMeta`` ↔ row dict (cache adapter).

``float_pct`` is persisted as a string so the Parquet file is portable
across backends (Postgres NUMERIC, SQLite TEXT) and free of float
rounding. ``date`` / ``datetime`` use native Arrow types so filters work
without string parsing.

M3 enrichment columns (``total_share`` / ``float_share`` / ``net_assets``
/ ``net_assets_period`` / ``quarterlies_json`` / ``financials_updated_at``)
are nullable so legacy parquet files written with the v1 schema can be
read back without migration: ``parquet_record_repo`` projects missing
columns to ``None`` at read time. Quarterlies are serialised as a single
JSON string column to keep the schema flat across arrow JS / Python
bindings — see ``docs/modules/01-stock-meta.md`` §4 for the rationale.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_core.domain.types.stock import PersistedMetrics, QuarterlyFinancials, StockMeta

from quant_cache.parquet_record_repo import Codec

if TYPE_CHECKING:
    from collections.abc import Mapping


STOCK_META_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("name", pa.string()),
        ("name_pinyin", pa.string()),
        ("industries", pa.string()),
        ("list_date", pa.date32()),
        ("float_pct", pa.string()),
        ("updated_at", pa.timestamp("us", tz="UTC")),
        # M3 financial enrichment — all nullable for backwards compat.
        ("total_share", pa.string()),
        ("float_share", pa.string()),
        ("net_assets", pa.string()),
        ("net_assets_period", pa.date32()),
        ("quarterlies_json", pa.string()),
        ("financials_updated_at", pa.timestamp("us", tz="UTC")),
        # Persisted snapshot projection (storage-unify item 9). Populated
        # after each kline sync by ``upsert_stock_metrics_for_code``; all
        # nullable so legacy v1/v2 rows read back without migration.
        ("metrics_asof", pa.date32()),
        ("metrics_updated_at", pa.timestamp("us", tz="UTC")),
        ("metrics_price", pa.string()),
        ("ret_1d", pa.string()),
        ("ret_5d", pa.string()),
        ("ret_10d", pa.string()),
        ("ret_20d", pa.string()),
        ("ret_90d", pa.string()),
        ("ret_250d", pa.string()),
        ("mkt_cap", pa.string()),
        ("float_mkt_cap", pa.string()),
        ("pe_ttm", pa.string()),
        ("pe_dynamic", pa.string()),
        ("pb", pa.string()),
        ("peg", pa.string()),
        ("gross_margin_ttm", pa.string()),
    ]
)
"""Schema of the stock-meta parquet file."""

_METRIC_DECIMAL_FIELDS: Final[tuple[str, ...]] = (
    "ret_1d",
    "ret_5d",
    "ret_10d",
    "ret_20d",
    "ret_90d",
    "ret_250d",
    "mkt_cap",
    "float_mkt_cap",
    "pe_ttm",
    "pe_dynamic",
    "pb",
    "peg",
    "gross_margin_ttm",
)

# Same logical field but stored under a prefixed column name to avoid
# colliding with a future top-level ``price`` field on stock_meta.
_METRIC_PRICE_FIELD: Final[str] = "metrics_price"

STOCK_META_KEY_FIELD: Final[str] = "code"


def stock_meta_to_row(item: StockMeta) -> Mapping[str, object]:
    row: dict[str, object] = {
        "code": item.code,
        "name": item.name,
        "name_pinyin": item.name_pinyin,
        "industries": item.industries,
        "list_date": item.list_date,
        "float_pct": str(item.float_pct),
        "updated_at": item.updated_at,
        "total_share": _decimal_to_str_or_none(item.total_share),
        "float_share": _decimal_to_str_or_none(item.float_share),
        "net_assets": _decimal_to_str_or_none(item.net_assets),
        "net_assets_period": item.net_assets_period,
        "quarterlies_json": _quarterlies_to_json(item.quarterlies),
        "financials_updated_at": item.financials_updated_at,
        "metrics_asof": item.metrics.asof if item.metrics is not None else None,
        "metrics_updated_at": item.metrics_updated_at,
        _METRIC_PRICE_FIELD: _decimal_to_str_or_none(
            item.metrics.price if item.metrics is not None else None,
        ),
    }
    for field_name in _METRIC_DECIMAL_FIELDS:
        value = getattr(item.metrics, field_name) if item.metrics is not None else None
        row[field_name] = _decimal_to_str_or_none(value)
    return row


def stock_meta_from_row(row: Mapping[str, object]) -> StockMeta:
    list_date = row["list_date"]
    updated_at = row["updated_at"]
    if not isinstance(list_date, date):
        raise ValueError(f"list_date must be a date, got {type(list_date).__name__}")
    if not isinstance(updated_at, datetime):
        raise ValueError(f"updated_at must be a datetime, got {type(updated_at).__name__}")
    if updated_at.tzinfo is None:
        raise ValueError("updated_at must be timezone-aware")
    return StockMeta(
        code=str(row["code"]),
        name=str(row["name"]),
        name_pinyin=str(row["name_pinyin"]),
        industries=str(row["industries"]),
        list_date=list_date,
        float_pct=Decimal(str(row["float_pct"])),
        updated_at=updated_at,
        total_share=_str_to_decimal_or_none(row.get("total_share")),
        float_share=_str_to_decimal_or_none(row.get("float_share")),
        net_assets=_str_to_decimal_or_none(row.get("net_assets")),
        net_assets_period=_date_or_none(row.get("net_assets_period")),
        quarterlies=_json_to_quarterlies(row.get("quarterlies_json")),
        financials_updated_at=_datetime_or_none(row.get("financials_updated_at")),
        metrics=_persisted_metrics_from_row(row),
        metrics_updated_at=_datetime_or_none(row.get("metrics_updated_at"), field="metrics_updated_at"),
    )


def _persisted_metrics_from_row(row: Mapping[str, object]) -> PersistedMetrics | None:
    asof = _date_or_none(row.get("metrics_asof"), field="metrics_asof")
    price = _str_to_decimal_or_none(row.get(_METRIC_PRICE_FIELD))
    decimals = {f: _str_to_decimal_or_none(row.get(f)) for f in _METRIC_DECIMAL_FIELDS}
    # All-null + no asof + no price → no projection yet. Anything non-null
    # on the other side → keep a populated block.
    if asof is None and price is None and not any(v is not None for v in decimals.values()):
        return None
    return PersistedMetrics(asof=asof, price=price, **decimals)


def stock_meta_key(item: StockMeta) -> str:
    return item.code


STOCK_META_CODEC: Final[Codec[StockMeta]] = Codec(
    to_row=stock_meta_to_row,
    from_row=stock_meta_from_row,
    key_of=stock_meta_key,
)


# -- internal helpers --------------------------------------------------------


def _decimal_to_str_or_none(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def _str_to_decimal_or_none(value: object) -> Decimal | None:
    if value is None or value == "":
        return None
    return Decimal(str(value))


def _date_or_none(value: object, *, field: str = "net_assets_period") -> date | None:
    if value is None:
        return None
    if not isinstance(value, date):
        raise ValueError(f"{field} must be a date, got {type(value).__name__}")
    return value


def _datetime_or_none(
    value: object, *, field: str = "financials_updated_at"
) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, datetime):
        raise ValueError(f"{field} must be a datetime, got {type(value).__name__}")
    if value.tzinfo is None:
        raise ValueError(f"{field} must be timezone-aware")
    return value


def _quarterlies_to_json(items: tuple[QuarterlyFinancials, ...]) -> str | None:
    if not items:
        return None
    return json.dumps(
        [
            {
                "period": q.period.isoformat(),
                "revenue": _decimal_to_str_or_none(q.revenue),
                "operating_cost": _decimal_to_str_or_none(q.operating_cost),
                "net_profit": _decimal_to_str_or_none(q.net_profit),
                "net_profit_excl_nr": _decimal_to_str_or_none(q.net_profit_excl_nr),
            }
            for q in items
        ],
        separators=(",", ":"),
    )


def _json_to_quarterlies(value: object) -> tuple[QuarterlyFinancials, ...]:
    if value is None or value == "":
        return ()
    if not isinstance(value, str):
        raise ValueError(f"quarterlies_json must be a string, got {type(value).__name__}")
    raw = json.loads(value)
    if not isinstance(raw, list):
        raise ValueError("quarterlies_json must decode to a list")
    out: list[QuarterlyFinancials] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError("quarterlies_json entries must be dicts")
        out.append(
            QuarterlyFinancials(
                period=date.fromisoformat(str(entry["period"])),
                revenue=_str_to_decimal_or_none(entry.get("revenue")),
                operating_cost=_str_to_decimal_or_none(entry.get("operating_cost")),
                net_profit=_str_to_decimal_or_none(entry.get("net_profit")),
                net_profit_excl_nr=_str_to_decimal_or_none(entry.get("net_profit_excl_nr")),
            )
        )
    return tuple(out)
