"""Pyarrow schema + codec for ``StockMeta`` ↔ row dict (cache adapter).

``float_pct`` is persisted as a string so the Parquet file is portable
across backends (Postgres NUMERIC, SQLite TEXT) and free of float
rounding. ``date`` / ``datetime`` use native Arrow types so filters work
without string parsing.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_core.domain.types.stock import StockMeta

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
    ]
)
"""Schema of the stock-meta parquet file."""

STOCK_META_KEY_FIELD: Final[str] = "code"


def stock_meta_to_row(item: StockMeta) -> Mapping[str, object]:
    return {
        "code": item.code,
        "name": item.name,
        "name_pinyin": item.name_pinyin,
        "industries": item.industries,
        "list_date": item.list_date,
        "float_pct": str(item.float_pct),
        "updated_at": item.updated_at,
    }


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
    )


def stock_meta_key(item: StockMeta) -> str:
    return item.code


STOCK_META_CODEC: Final[Codec[StockMeta]] = Codec(
    to_row=stock_meta_to_row,
    from_row=stock_meta_from_row,
    key_of=stock_meta_key,
)
