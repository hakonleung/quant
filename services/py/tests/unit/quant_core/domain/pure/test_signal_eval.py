"""Unit tests for :func:`evaluate_signal`."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from quant_core.domain.pure.signal_eval import evaluate_signal
from quant_core.domain.types.signal_eval import Bar, SignalInput
from quant_core.errors import QuantError


def _bars(prices: list[float], start: date = date(2024, 1, 2)) -> tuple[Bar, ...]:
    """Build trading-day bars at consecutive (calendar) days from `start`.

    Using consecutive calendar days is fine — the function treats every
    bar as one trading day regardless of weekday gaps.
    """
    return tuple(
        Bar(trade_date=start + timedelta(days=i), open_qfq=Decimal(str(p)))
        for i, p in enumerate(prices)
    )


# --- golden path -----------------------------------------------------------


def test_single_signal_single_holding_produces_one_observation() -> None:
    bars = {"A": _bars([10.0, 11.0, 12.0])}  # T0, T+1, T+2
    sigs = [SignalInput(signal_date=date(2024, 1, 2), code="A")]

    result = evaluate_signal(sigs, bars, [1])

    assert len(result.observations) == 1
    obs = result.observations[0]
    # entry = T+1 (the bar AFTER signal_date), exit = T+1+1
    assert obs.entry_date == date(2024, 1, 3)
    assert obs.exit_date == date(2024, 1, 4)
    assert obs.entry_px == Decimal("11.0")
    assert obs.exit_px == Decimal("12.0")
    assert obs.ret == pytest.approx(12.0 / 11.0 - 1.0)
    assert obs.holding == 1


def test_multiple_holdings_share_entry_price() -> None:
    bars = {"A": _bars([10.0, 11.0, 12.0, 13.0, 14.0, 15.0])}
    sigs = [SignalInput(signal_date=date(2024, 1, 2), code="A")]

    result = evaluate_signal(sigs, bars, [1, 3])

    assert len(result.observations) == 2
    by_h = {o.holding: o for o in result.observations}
    # Entry bar is the same in both: bar after signal_date == 11.0
    assert by_h[1].entry_px == Decimal("11.0")
    assert by_h[3].entry_px == Decimal("11.0")
    assert by_h[1].exit_px == Decimal("12.0")
    assert by_h[3].exit_px == Decimal("14.0")


def test_summary_stats_match_expected_for_known_returns() -> None:
    # Two signals with identical bars → two observations at holding=1
    # rets ≈ [+10%, +20%]
    bars = {
        "A": _bars([10.0, 11.0, 12.0]),  # ret @ signal T0 = 12/11 - 1 ≈ 0.0909
        "B": _bars([10.0, 10.0, 12.0]),  # ret @ signal T0 = 12/10 - 1 = 0.2
    }
    sigs = [
        SignalInput(signal_date=date(2024, 1, 2), code="A"),
        SignalInput(signal_date=date(2024, 1, 2), code="B"),
    ]
    result = evaluate_signal(sigs, bars, [1])

    assert len(result.summary) == 1
    s = result.summary[0]
    assert s.holding == 1
    assert s.n == 2
    assert s.win_rate == 1.0
    assert s.mean == pytest.approx((12 / 11 - 1 + 12 / 10 - 1) / 2)
    assert s.median == pytest.approx((12 / 11 - 1 + 12 / 10 - 1) / 2)


# --- entry / exit truncation ----------------------------------------------


def test_signal_with_no_forward_bar_is_dropped() -> None:
    bars = {"A": _bars([10.0, 11.0])}  # last bar = signal_date
    sigs = [SignalInput(signal_date=date(2024, 1, 3), code="A")]  # T+1 of bars

    result = evaluate_signal(sigs, bars, [1])

    assert result.observations == ()
    assert result.summary[0].n == 0


def test_holding_past_last_bar_is_dropped_but_smaller_holdings_kept() -> None:
    bars = {"A": _bars([10.0, 11.0, 12.0, 13.0])}  # 4 bars
    sigs = [SignalInput(signal_date=date(2024, 1, 2), code="A")]

    result = evaluate_signal(sigs, bars, [1, 5])

    # entry = pos 1; pos 1+1 = pos 2 ok; pos 1+5 = pos 6 out of range
    holdings = sorted({o.holding for o in result.observations})
    assert holdings == [1]
    assert result.summary[0].holding == 1
    assert result.summary[0].n == 1
    assert result.summary[1].holding == 5
    assert result.summary[1].n == 0


def test_signal_for_unknown_code_is_dropped() -> None:
    bars = {"A": _bars([10.0, 11.0, 12.0])}
    sigs = [SignalInput(signal_date=date(2024, 1, 2), code="MISSING")]

    result = evaluate_signal(sigs, bars, [1])

    assert result.observations == ()


def test_non_positive_entry_price_dropped() -> None:
    bars = {"A": _bars([10.0, 0.0, 12.0])}
    sigs = [SignalInput(signal_date=date(2024, 1, 2), code="A")]
    result = evaluate_signal(sigs, bars, [1])
    assert result.observations == ()


# --- ordering / dedup / meta ----------------------------------------------


def test_holdings_are_deduped_and_sorted() -> None:
    bars = {"A": _bars([10.0, 11.0, 12.0, 13.0])}
    sigs = [SignalInput(signal_date=date(2024, 1, 2), code="A")]

    result = evaluate_signal(sigs, bars, [2, 1, 2])

    assert result.holdings == (1, 2)
    assert [s.holding for s in result.summary] == [1, 2]


def test_observations_sorted_by_date_code_holding() -> None:
    bars = {
        "B": _bars([10.0, 11.0, 12.0]),
        "A": _bars([10.0, 11.0, 12.0]),
    }
    sigs = [
        SignalInput(signal_date=date(2024, 1, 3), code="A"),  # later signal
        SignalInput(signal_date=date(2024, 1, 2), code="B"),
        SignalInput(signal_date=date(2024, 1, 2), code="A"),
    ]
    # bars start 2024-01-02; for code A signal on 2024-01-03, entry at
    # pos with date > 2024-01-03 → pos 2 (2024-01-04). For signal on
    # 2024-01-02, entry at pos 1 (2024-01-03). Both have exit only at
    # holding 1 since the bar series is length 3.
    bars["A"] = _bars([10.0, 11.0, 12.0, 13.0])  # extend so 01-03 signal also produces
    result = evaluate_signal(sigs, bars, [1])
    keys = [(o.signal_date.isoformat(), o.code) for o in result.observations]
    assert keys == sorted(keys)


def test_universe_size_avg_counts_per_day() -> None:
    bars = {
        "A": _bars([10.0, 11.0, 12.0]),
        "B": _bars([10.0, 11.0, 12.0]),
        "C": _bars([10.0, 11.0, 12.0]),
    }
    sigs = [
        SignalInput(signal_date=date(2024, 1, 2), code="A"),
        SignalInput(signal_date=date(2024, 1, 2), code="B"),
        SignalInput(signal_date=date(2024, 1, 2), code="C"),
        # next day only 1 signal — same code repeats are allowed
        SignalInput(signal_date=date(2024, 1, 3), code="A"),
    ]
    result = evaluate_signal(sigs, bars, [1])
    # (3 + 1) / 2 days = 2.0
    assert result.universe_size_avg == pytest.approx(2.0)
    assert result.signal_date_range == (date(2024, 1, 2), date(2024, 1, 3))


def test_empty_signals_yields_empty_result_with_zero_summary_rows() -> None:
    result = evaluate_signal([], {}, [5, 10])
    assert result.observations == ()
    assert result.holdings == (5, 10)
    assert all(s.n == 0 for s in result.summary)
    assert result.signal_date_range is None
    assert result.universe_size_avg == 0.0


# --- error paths -----------------------------------------------------------


def test_empty_holdings_raises() -> None:
    with pytest.raises(QuantError) as exc:
        evaluate_signal([], {}, [])
    assert exc.value.code == "INVALID_ARGUMENT"


def test_non_positive_holding_raises() -> None:
    with pytest.raises(QuantError) as exc:
        evaluate_signal([], {}, [5, 0])
    assert exc.value.code == "INVALID_ARGUMENT"


def test_unsorted_bars_raise() -> None:
    bars_bad = (
        Bar(trade_date=date(2024, 1, 3), open_qfq=Decimal("10")),
        Bar(trade_date=date(2024, 1, 2), open_qfq=Decimal("11")),
    )
    with pytest.raises(QuantError) as exc:
        evaluate_signal(
            [SignalInput(signal_date=date(2024, 1, 1), code="A")],
            {"A": bars_bad},
            [1],
        )
    assert exc.value.code == "INVALID_ARGUMENT"


# --- summary stats edge cases ---------------------------------------------


def test_summary_quantiles_on_known_distribution() -> None:
    # Build 11 observations with controlled returns. With 11 bars and
    # signal at idx 0, entry=pos 1; we need exit at pos 2 for holding=1.
    # Easier: synthesise per-code 2-bar series so each (T0, code) yields
    # exactly one observation with a chosen return.
    bars: dict[str, tuple[Bar, ...]] = {}
    sigs: list[SignalInput] = []
    # Use exit prices chosen so entry=100, exit=K give exact returns
    # with no float rounding (multiples of 1 over 100).
    exits = [90, 95, 98, 99, 100, 101, 102, 103, 105, 108, 110]
    for i, exit_px in enumerate(exits):
        code = f"C{i}"
        bars[code] = _bars([100.0, 100.0, float(exit_px)])
        sigs.append(SignalInput(signal_date=date(2024, 1, 2), code=code))

    result = evaluate_signal(sigs, bars, [1])
    s = result.summary[0]
    assert s.n == 11
    # 6 positives out of 11 (exits > 100). Zero is not a win.
    assert s.win_rate == pytest.approx(6 / 11)
    # Median of 11 sorted rets = element at index 5 = (101/100 - 1) = 0.01
    assert s.median == pytest.approx(0.01)
    assert s.std > 0
    assert s.sharpe_like == pytest.approx(s.mean / s.std)


# --- baseline / spread ----------------------------------------------------


def test_baseline_attached_to_observations_and_summary() -> None:
    bars = {
        "A": _bars([10.0, 11.0, 12.0]),
        "B": _bars([10.0, 11.0, 13.0]),
    }
    sigs = [
        SignalInput(signal_date=date(2024, 1, 2), code="A"),
        SignalInput(signal_date=date(2024, 1, 2), code="B"),
    ]
    # Baselines are keyed by ENTRY day (the trading day open the trade
    # actually happens on). Signal on 2024-01-02 → entry on 2024-01-03.
    baselines = {1: {date(2024, 1, 3): (0.05, 0.02)}}

    result = evaluate_signal(sigs, bars, [1], baselines=baselines)

    assert all(o.baseline_mean == 0.05 for o in result.observations)
    assert result.baseline_summary is not None
    assert len(result.baseline_summary) == 1
    b = result.baseline_summary[0]
    assert b.holding == 1
    assert b.n == 1
    assert b.universe_mean == pytest.approx(0.05)

    assert result.spread_summary is not None
    sp = result.spread_summary[0]
    # Signal returns at h=1: 12/11-1, 13/11-1; mean ≈ 0.1364.
    expected_signal_mean = ((12 / 11) - 1 + (13 / 11) - 1) / 2
    assert sp.spread_mean == pytest.approx(expected_signal_mean - 0.05)
    assert sp.n == 1
    # n=1 → no t-stat (need ≥ 2 dates for std)
    assert sp.spread_t_stat == 0.0


def test_no_baselines_leaves_excess_fields_none() -> None:
    bars = {"A": _bars([10.0, 11.0, 12.0])}
    sigs = [SignalInput(signal_date=date(2024, 1, 2), code="A")]

    result = evaluate_signal(sigs, bars, [1])

    assert result.baseline_summary is None
    assert result.spread_summary is None
    assert all(o.baseline_mean is None and o.excess_ret is None for o in result.observations)


def test_spread_t_stat_aggregates_over_dates() -> None:
    # Two signal dates, each with one selected code beating baseline by
    # the same amount. With n=2 we can compute t.
    bars = {
        "A": _bars([10.0, 11.0, 12.0]),  # h=1 ret on 01-02 = 12/11-1
        "B": _bars([10.0, 11.0, 12.0], start=date(2024, 1, 3)),  # h=1 ret on 01-03
    }
    sigs = [
        SignalInput(signal_date=date(2024, 1, 2), code="A"),
        SignalInput(signal_date=date(2024, 1, 3), code="B"),
    ]
    baselines = {
        1: {
            # Keyed by entry day = signal_date + 1 trading day.
            date(2024, 1, 3): (0.05, 0.0),
            date(2024, 1, 4): (0.04, 0.0),
        }
    }
    result = evaluate_signal(sigs, bars, [1], baselines=baselines)
    assert result.spread_summary is not None
    sp = result.spread_summary[0]
    assert sp.n == 2
    # Both spreads positive → win_rate == 1.0; t-stat > 0 when std > 0.
    assert sp.win_rate == pytest.approx(1.0)
    if sp.spread_std > 0.0:
        assert sp.spread_t_stat > 0.0
