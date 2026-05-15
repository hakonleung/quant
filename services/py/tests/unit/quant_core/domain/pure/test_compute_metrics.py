"""Pure-function tests for :func:`compute_metrics`.

Golden path + boundary + invariant coverage per CLAUDE.md §3.3:
  - happy: returns + derived populated from a full bar history
  - boundaries: empty bars; non-positive close; bar count < window
  - invariants: ``asof`` matches latest bar; window N=1 = (latest-prev)/prev
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from quant_core.domain.pure.compute_metrics import compute_metrics
from quant_core.domain.types.kline import DailyBar
from quant_core.domain.types.stock import StockMeta


def _bar(code: str, day_offset: int, close: Decimal) -> DailyBar:
    return DailyBar(
        code=code,
        trade_date=date(2026, 1, 1) + (
            __import__("datetime").timedelta(days=day_offset)
        ),
        open=close,
        high=close,
        low=close,
        close=close,
        volume=0,
        amount=Decimal(0),
        turnover_rate=Decimal(0),
        open_qfq=close,
        high_qfq=close,
        low_qfq=close,
        close_qfq=close,
        ma5=None,
        ma10=None,
        ma20=None,
        ma60=None,
        pct_chg_qfq=None,
        adj_factor=Decimal(1),
    )


_BASE_META = StockMeta(
    code="000001",
    name="测试",
    name_pinyin="CS",
    industries="bank",
    list_date=date(2020, 1, 1),
    float_pct=Decimal("1"),
    updated_at=datetime(2026, 1, 1, tzinfo=UTC),
)


@pytest.mark.unit
def test_compute_metrics_with_no_bars_returns_all_nones() -> None:
    metrics = compute_metrics(_BASE_META, [])
    assert metrics.asof is None
    assert metrics.ret_1d is None
    assert metrics.ret_250d is None
    assert metrics.mkt_cap is None
    assert metrics.gross_margin_ttm is None


@pytest.mark.unit
def test_compute_metrics_ret_1d_matches_latest_vs_previous_close() -> None:
    bars = [_bar("000001", 0, Decimal("10")), _bar("000001", 1, Decimal("11"))]
    metrics = compute_metrics(_BASE_META, bars)
    assert metrics.asof == bars[-1].trade_date
    assert metrics.ret_1d == Decimal("11") / Decimal("10") - 1


@pytest.mark.unit
def test_compute_metrics_skips_windows_longer_than_available_history() -> None:
    bars = [_bar("000001", i, Decimal("10") + Decimal(i) * Decimal("0.1")) for i in range(3)]
    metrics = compute_metrics(_BASE_META, bars)
    assert metrics.ret_1d is not None
    assert metrics.ret_5d is None
    assert metrics.ret_250d is None


@pytest.mark.unit
def test_compute_metrics_with_non_positive_close_yields_none_returns() -> None:
    bars = [
        _bar("000001", 0, Decimal("10")),
        _bar("000001", 1, Decimal("0")),  # halted / bad data
    ]
    metrics = compute_metrics(_BASE_META, bars)
    assert metrics.ret_1d is None


@pytest.mark.unit
def test_compute_metrics_long_window_includes_oldest_bar() -> None:
    bars = [_bar("000001", i, Decimal("10") + Decimal(i)) for i in range(0, 21)]
    metrics = compute_metrics(_BASE_META, bars)
    base = bars[0].close_qfq
    latest = bars[-1].close_qfq
    assert metrics.ret_20d == (latest - base) / base
