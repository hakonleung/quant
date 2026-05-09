"""Flight op for stock snapshots (modules/01-stock-meta.md §6.4).

``list_stock_snapshots`` — args ``{"codes": ["600519", ...]}``; returns
one row per code carrying the full :class:`StockMeta` columns plus the
seven price-derived metrics from
:func:`quant_core.domain.pure.derive_metrics` and the configured period
returns (``ret_5d`` / ``ret_10d`` / ``ret_20d`` / ``ret_90d`` /
``ret_250d``) computed against ``close_qfq``. An empty ``codes`` list
expands to the full meta universe (mirrors ``kline/bulk``).

Codes that the meta cache doesn't know are silently dropped; codes
whose kline cache is empty produce a row with ``price`` / ``asof`` /
every derived & return field set to ``None``. A return field stays
``None`` when the kline history is shorter than the requested window.

The Arrow schema is **not** the meta schema with extra columns — it's a
fresh schema (``STOCK_SNAPSHOT_SCHEMA``) so future read paths can detect
"snapshot table" by `schema.names` without coupling to the meta codec.
"""

from __future__ import annotations

import time
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

# Period-return windows surfaced by EQ.LIST. Order matters — the largest
# value also doubles as the kline read depth (we slice once per code).
RETURN_WINDOWS: Final[tuple[int, ...]] = (5, 10, 20, 90, 250)


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
    for window in RETURN_WINDOWS:
        fields.append(pa.field(f"ret_{window}d", pa.string()))
    return pa.schema(fields)


STOCK_SNAPSHOT_SCHEMA: Final[pa.Schema] = _build_snapshot_schema()


def _dec_to_str(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def _row(
    meta: StockMeta,
    price: Decimal | None,
    asof: date | None,
    m: DerivedMetrics,
    returns: Mapping[int, Decimal | None],
) -> dict[str, object]:
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
    for window in RETURN_WINDOWS:
        base[f"ret_{window}d"] = _dec_to_str(returns.get(window))
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


_FULL_CACHE_TTL_SEC: Final[float] = 300.0


class ListStockSnapshotsHandler:
    """``list_stock_snapshots`` — meta + latest close + derived metrics.

    Full-universe expansion (empty ``codes``) is expensive — ~5 500
    parquet reads per request — so we cache that path in-process with a
    5-minute TTL. Daily price + qfq closes are stable within a trading
    day; the worst-case staleness is one cache window. Targeted
    ``codes`` are read fresh because the call is cheap and callers may
    legitimately ask for the same code twice for different prices."""

    op = _OP
    schema = STOCK_SNAPSHOT_SCHEMA

    __slots__ = ("_kline", "_meta", "_full_cache", "_full_cache_at")

    def __init__(self, meta_service: StockMetaService, kline_service: KlineService) -> None:
        self._meta = meta_service
        self._kline = kline_service
        self._full_cache: pa.Table | None = None
        self._full_cache_at: float = 0.0

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        codes = _require_str_list(args, "codes")
        # Empty ``codes`` mirrors ``kline/bulk`` semantics: expand to the
        # full meta universe so EQ.LIST's synthetic "All" sector can fetch
        # snapshots in one Flight call instead of stuffing thousands of
        # codes into a query string.
        if not codes:
            cached = self._cached_full_universe()
            if cached is not None:
                return cached
        metas = self._meta.list_all() if not codes else self._meta.get_batch(codes)
        rows: list[dict[str, object]] = []
        for meta in metas:
            price, asof, returns = self._latest_close_and_returns(meta.code)
            derived = derive_metrics(meta, price)
            rows.append(_row(meta, price, asof, derived, returns))
        if not rows:
            return STOCK_SNAPSHOT_SCHEMA.empty_table()
        table = pa.Table.from_pylist(rows, schema=STOCK_SNAPSHOT_SCHEMA)
        if not codes:
            self._full_cache = table
            self._full_cache_at = time.monotonic()
        return table

    def _cached_full_universe(self) -> pa.Table | None:
        if self._full_cache is None:
            return None
        if (time.monotonic() - self._full_cache_at) > _FULL_CACHE_TTL_SEC:
            return None
        return self._full_cache

    def _latest_close_and_returns(
        self, code: str
    ) -> tuple[Decimal | None, date | None, dict[int, Decimal | None]]:
        """Resolve the most recent ``close_qfq`` plus period returns.

        We slice the largest configured window once and derive every
        smaller window from the same buffer — one parquet read per code
        instead of N. Missing windows (kline shorter than the lookback)
        come back as ``None``. Failures are swallowed → empty triple.
        """
        empty: dict[int, Decimal | None] = {w: None for w in RETURN_WINDOWS}
        depth = max(RETURN_WINDOWS) + 1  # +1 because ret needs the bar N steps back
        try:
            table = self._kline.get_last_n(code, depth)
        except Exception:  # noqa: BLE001 — repo boundary
            return (None, None, empty)
        if table.num_rows == 0:
            return (None, None, empty)
        rows = table.to_pylist()
        last = rows[-1]
        raw_close = last.get("close_qfq")
        # Kline parquet uses ``trade_date`` (KLINE_SCHEMA); the legacy
        # ``date`` lookup left ``asof`` permanently null on every
        # snapshot row even when the kline cache was populated.
        raw_date = last.get("trade_date")
        latest = self._coerce_decimal(raw_close)
        asof = raw_date if isinstance(raw_date, date) else None
        if latest is None or latest <= 0:
            return (latest, asof, empty)
        returns: dict[int, Decimal | None] = {}
        for window in RETURN_WINDOWS:
            idx = len(rows) - 1 - window
            if idx < 0:
                returns[window] = None
                continue
            base = self._coerce_decimal(rows[idx].get("close_qfq"))
            if base is None or base <= 0:
                returns[window] = None
                continue
            returns[window] = (latest - base) / base
        return (latest, asof, returns)

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
