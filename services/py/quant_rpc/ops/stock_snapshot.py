"""Flight op for stock snapshots (modules/01-stock-meta.md §6.4).

``list_stock_snapshots`` — args ``{"codes": ["600519", ...]}``; returns
one row per code carrying the full :class:`StockMeta` columns plus the
seven price-derived metrics from
:func:`quant_core.domain.pure.derive_metrics`. Codes that the meta cache
doesn't know are silently dropped (mirrors ``get_stock_meta_batch``);
codes whose kline cache is empty produce a row with ``price`` /
``asof`` / every derived field set to ``None``.

The Arrow schema is **not** the meta schema with extra columns — it's a
fresh schema (``STOCK_SNAPSHOT_SCHEMA``) so future read paths can detect
"snapshot table" by `schema.names` without coupling to the meta codec.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_cache.stock_meta_schema import STOCK_META_SCHEMA, stock_meta_to_row
from quant_core.domain.pure.derive_metrics import DerivedMetrics, derive_metrics
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.domain.types.stock import StockMeta
    from quant_core.services.kline_service import KlineService
    from quant_core.services.stock_meta_service import StockMetaService


_OP: Final[str] = "list_stock_snapshots"


def _build_snapshot_schema() -> pa.Schema:
    fields = list(STOCK_META_SCHEMA)
    fields.append(pa.field("price", pa.string()))
    fields.append(pa.field("asof", pa.date32()))
    for name in (
        "mkt_cap",
        "float_mkt_cap",
        "pe_ttm",
        "pe_dynamic",
        "pb",
        "peg",
        "gross_margin_ttm",
    ):
        fields.append(pa.field(name, pa.string()))
    return pa.schema(fields)


STOCK_SNAPSHOT_SCHEMA: Final[pa.Schema] = _build_snapshot_schema()


def _dec_to_str(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def _row(meta: StockMeta, price: Decimal | None, asof: date | None, m: DerivedMetrics) -> dict[str, object]:
    base = dict(stock_meta_to_row(meta))
    base.update(
        price=_dec_to_str(price),
        asof=asof,
        mkt_cap=_dec_to_str(m.mkt_cap),
        float_mkt_cap=_dec_to_str(m.float_mkt_cap),
        pe_ttm=_dec_to_str(m.pe_ttm),
        pe_dynamic=_dec_to_str(m.pe_dynamic),
        pb=_dec_to_str(m.pb),
        peg=_dec_to_str(m.peg),
        gross_margin_ttm=_dec_to_str(m.gross_margin_ttm),
    )
    return base


def _require_str_list(args: Mapping[str, object], key: str) -> list[str]:
    raw = args.get(key)
    if not isinstance(raw, list):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a list of strings",
            {"got": type(raw).__name__},
        )
    out: list[str] = []
    for i, value in enumerate(raw):
        if not isinstance(value, str):
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.{key}[{i}] must be a string",
                {"index": i, "got": type(value).__name__},
            )
        out.append(value)
    return out


class ListStockSnapshotsHandler:
    """``list_stock_snapshots`` — meta + latest close + derived metrics."""

    op = _OP
    schema = STOCK_SNAPSHOT_SCHEMA

    __slots__ = ("_kline", "_meta")

    def __init__(self, meta_service: StockMetaService, kline_service: KlineService) -> None:
        self._meta = meta_service
        self._kline = kline_service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        codes = _require_str_list(args, "codes")
        if not codes:
            return STOCK_SNAPSHOT_SCHEMA.empty_table()
        metas = self._meta.get_batch(codes)
        rows: list[dict[str, object]] = []
        for meta in metas:
            price, asof = self._latest_close(meta.code)
            derived = derive_metrics(meta, price)
            rows.append(_row(meta, price, asof, derived))
        if not rows:
            return STOCK_SNAPSHOT_SCHEMA.empty_table()
        return pa.Table.from_pylist(rows, schema=STOCK_SNAPSHOT_SCHEMA)

    def _latest_close(self, code: str) -> tuple[Decimal | None, date | None]:
        """Resolve the most recent ``close_qfq`` for ``code``.

        Failures are swallowed → ``(None, None)``: the snapshot row stays
        emit-able with derived metrics nulled out, exactly like a code
        whose kline cache is cold. Callers see the same "data not yet
        available" UX whether the cause is missing parquet or a transient
        I/O glitch.
        """
        try:
            table = self._kline.get_last_n(code, 1)
        except Exception:  # noqa: BLE001 — repo boundary
            return (None, None)
        if table.num_rows == 0:
            return (None, None)
        proxy = table.slice(table.num_rows - 1, 1).to_pylist()[0]
        raw_close = proxy.get("close_qfq")
        raw_date = proxy.get("date")
        close = self._coerce_decimal(raw_close)
        if not isinstance(raw_date, date):
            raw_date = None
        return (close, raw_date)

    @staticmethod
    def _coerce_decimal(value: object) -> Decimal | None:
        if value is None:
            return None
        if isinstance(value, Decimal):
            return value
        try:
            return Decimal(str(value))
        except Exception:  # noqa: BLE001 — defensive
            return None
