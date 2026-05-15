"""Pure projector: ``(StockMeta, kline_bars) -> StockMetrics``.

Persisted to ``data/stock_metas.parquet`` after each kline sync so the
list-view payload doesn't recompute on every read (see
``docs/perf/storage-unify-rollout.md`` item 9). Trigger: NestJS
``KlineWorker.process`` calls ``upsert_stock_metrics_for_code`` once
the new bars are written, then this projector picks them up locally.

口径 single-source-of-truth still lives in
:mod:`quant_core.domain.pure.derive_metrics` for the price-derived
half; this module only adds the return windows (``ret_*``) on top.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING, Final

from quant_core.domain.pure.derive_metrics import derive_metrics

if TYPE_CHECKING:
    from collections.abc import Sequence

    from quant_core.domain.types.kline import DailyBar
    from quant_core.domain.types.stock import StockMeta


# Trading-bar lookback per return window. ``1`` means "vs the bar
# immediately before ``latest``" — the convention the snapshot handler
# has been using since v1.
_RETURN_WINDOWS: Final[tuple[tuple[str, int], ...]] = (
    ("ret_1d", 1),
    ("ret_5d", 5),
    ("ret_10d", 10),
    ("ret_20d", 20),
    ("ret_90d", 90),
    ("ret_250d", 250),
)


@dataclass(frozen=True, slots=True)
class StockMetrics:
    """Persisted projection of the snapshot derived/returns block.

    Every field is nullable — a bar shortage on a young listing, a missing
    financial input, or a non-positive denominator all propagate to
    ``None`` so the UI's "—" path stays correct.

    ``asof`` is the latest kline ``trade_date`` the metrics were computed
    against. ``price`` (``close_qfq`` at ``asof``) rides along so the
    snapshot handler can serve the full row from this block alone,
    skipping a second kline read on every list request.
    """

    code: str
    asof: date | None
    price: Decimal | None
    # returns
    ret_1d: Decimal | None
    ret_5d: Decimal | None
    ret_10d: Decimal | None
    ret_20d: Decimal | None
    ret_90d: Decimal | None
    ret_250d: Decimal | None
    # derived (mirror of DerivedMetrics)
    mkt_cap: Decimal | None
    float_mkt_cap: Decimal | None
    pe_ttm: Decimal | None
    pe_dynamic: Decimal | None
    pb: Decimal | None
    peg: Decimal | None
    gross_margin_ttm: Decimal | None


_EMPTY_RETURNS: Final[dict[str, Decimal | None]] = {name: None for name, _ in _RETURN_WINDOWS}


def compute_metrics(meta: StockMeta, bars: Sequence[DailyBar]) -> StockMetrics:
    """Project a fresh :class:`StockMetrics` row for ``meta``.

    Args:
        meta: Current meta snapshot. Used for ``derive_metrics``
            (financials + share counts) and to thread the code through.
        bars: Trailing kline bars in ascending date order. The latest
            bar's ``close_qfq`` feeds both ``derive_metrics`` and the
            return-window math. May be empty — in that case every metric
            (including derived) is ``None`` and ``asof`` is ``None``.

    Returns:
        Frozen :class:`StockMetrics` ready for
        ``ParquetStockMetaRepo.upsert_metrics``.
    """
    if not bars:
        return StockMetrics(
            code=meta.code,
            asof=None,
            price=None,
            **_EMPTY_RETURNS,
            mkt_cap=None,
            float_mkt_cap=None,
            pe_ttm=None,
            pe_dynamic=None,
            pb=None,
            peg=None,
            gross_margin_ttm=None,
        )
    latest = bars[-1]
    latest_close = latest.close_qfq
    derived = derive_metrics(meta, latest_close)
    returns = _compute_returns(bars, latest_close)
    return StockMetrics(
        code=meta.code,
        asof=latest.trade_date,
        price=latest_close if latest_close > 0 else None,
        **returns,
        mkt_cap=derived.mkt_cap,
        float_mkt_cap=derived.float_mkt_cap,
        pe_ttm=derived.pe_ttm,
        pe_dynamic=derived.pe_dynamic,
        pb=derived.pb,
        peg=derived.peg,
        gross_margin_ttm=derived.gross_margin_ttm,
    )


def _compute_returns(
    bars: Sequence[DailyBar], latest_close: Decimal
) -> dict[str, Decimal | None]:
    """Fractional change of ``latest_close`` vs the close N bars back.

    Returns ``None`` for any window where the bar count is insufficient
    or the historical close is non-positive.
    """
    if latest_close <= 0:
        return dict(_EMPTY_RETURNS)
    out: dict[str, Decimal | None] = {}
    for name, window in _RETURN_WINDOWS:
        if len(bars) <= window:
            out[name] = None
            continue
        base_close = bars[-1 - window].close_qfq
        if base_close <= 0:
            out[name] = None
            continue
        out[name] = (latest_close - base_close) / base_close
    return out
