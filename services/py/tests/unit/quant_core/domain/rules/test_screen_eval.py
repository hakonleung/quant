"""Unit tests for screen_eval — interprets a predicate against per-stock rows."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from quant_core.domain.rules.screen_eval import evaluate_predicate
from quant_core.domain.rules.screen_parse import parse_predicate


def _row(
    d: date,
    close_qfq: str,
    ma5: str | None = None,
    pct_chg_qfq: str | None = None,
    turnover_rate: str | None = None,
) -> dict[str, object]:
    return {
        "trade_date": d,
        "close_qfq": Decimal(close_qfq),
        "ma5": Decimal(ma5) if ma5 is not None else None,
        "pct_chg_qfq": Decimal(pct_chg_qfq) if pct_chg_qfq is not None else None,
        "turnover_rate": Decimal(turnover_rate) if turnover_rate is not None else None,
    }


def _series(closes: list[str], mas: list[str | None] | None = None) -> list[dict[str, object]]:
    base = date(2026, 1, 1)
    rows = []
    for i, c in enumerate(closes):
        ma_val = mas[i] if mas is not None and i < len(mas) else None
        rows.append(_row(base + timedelta(days=i), c, ma5=ma_val))
    return rows


@pytest.mark.unit
def test_compare_field_gt_const() -> None:
    pred = parse_predicate({"op": "gt", "left": {"field": "close_qfq"}, "right": {"const": 9}}, "/")
    assert evaluate_predicate(_series(["10"]), pred) is True


@pytest.mark.unit
def test_compare_field_field() -> None:
    pred = parse_predicate(
        {"op": "gt", "left": {"field": "close_qfq"}, "right": {"field": "ma5"}}, "/"
    )
    assert evaluate_predicate(_series(["10"], ["9"]), pred) is True
    assert evaluate_predicate(_series(["10"], ["11"]), pred) is False


@pytest.mark.unit
def test_for_all_close_above_ma5_five_days_all_true() -> None:
    pred = parse_predicate(
        {
            "op": "for_all",
            "window": {"days": 5},
            "predicate": {
                "op": "gt",
                "left": {"field": "close_qfq"},
                "right": {"field": "ma5"},
            },
        },
        "/",
    )
    rows = _series(
        ["10", "11", "12", "13", "14"],
        ["8", "9", "10", "11", "12"],
    )
    assert evaluate_predicate(rows, pred) is True


@pytest.mark.unit
def test_for_all_returns_false_when_window_too_small() -> None:
    pred = parse_predicate(
        {
            "op": "for_all",
            "window": {"days": 5},
            "predicate": {"op": "gt", "left": {"field": "close_qfq"}, "right": {"const": 0}},
        },
        "/",
    )
    rows = _series(["1", "2"])
    assert evaluate_predicate(rows, pred) is False


@pytest.mark.unit
def test_aggregate_mean_turnover_under_threshold() -> None:
    pred = parse_predicate(
        {
            "op": "lt",
            "left": {"agg": "mean", "field": "turnover_rate", "window": {"days": 3}},
            "right": {"const": 0.05},
        },
        "/",
    )
    rows = [
        _row(date(2026, 1, 1), "10", turnover_rate="0.01"),
        _row(date(2026, 1, 2), "10", turnover_rate="0.02"),
        _row(date(2026, 1, 3), "10", turnover_rate="0.03"),
    ]
    assert evaluate_predicate(rows, pred) is True


@pytest.mark.unit
def test_period_return_20d_threshold() -> None:
    pred = parse_predicate(
        {"op": "gt", "left": {"period_return": {"days": 2}}, "right": {"const": 0.30}}, "/"
    )
    rows = _series(["10", "11", "14"])
    assert evaluate_predicate(rows, pred) is True


@pytest.mark.unit
def test_period_return_insufficient_history_returns_false() -> None:
    pred = parse_predicate(
        {"op": "gt", "left": {"period_return": {"days": 20}}, "right": {"const": 0}}, "/"
    )
    rows = _series(["10", "11"])
    assert evaluate_predicate(rows, pred) is False


@pytest.mark.unit
def test_consecutive_five_day_streak() -> None:
    pred = parse_predicate(
        {
            "op": "consecutive",
            "min_len": 5,
            "predicate": {"op": "gt", "left": {"field": "pct_chg_qfq"}, "right": {"const": 0.02}},
        },
        "/",
    )
    base = date(2026, 1, 1)
    rows = [
        _row(base + timedelta(days=i), "10", pct_chg_qfq=v)
        for i, v in enumerate(["0.01", "0.03", "0.04", "0.05", "0.06", "0.07", "0.08"])
    ]
    assert evaluate_predicate(rows, pred) is True


@pytest.mark.unit
def test_logical_and_or_not() -> None:
    p_and = parse_predicate(
        {
            "op": "and",
            "args": [
                {"op": "gt", "left": {"field": "close_qfq"}, "right": {"const": 0}},
                {"op": "lt", "left": {"field": "close_qfq"}, "right": {"const": 100}},
            ],
        },
        "/",
    )
    assert evaluate_predicate(_series(["10"]), p_and) is True
    p_not = parse_predicate(
        {
            "op": "not",
            "args": [{"op": "gt", "left": {"field": "close_qfq"}, "right": {"const": 100}}],
        },
        "/",
    )
    assert evaluate_predicate(_series(["10"]), p_not) is True


def _rows_with_high(closes: list[str], highs: list[str]) -> list[dict[str, object]]:
    base = date(2026, 1, 1)
    return [
        {
            "trade_date": base + timedelta(days=i),
            "close_qfq": Decimal(c),
            "high_qfq": Decimal(h),
        }
        for i, (c, h) in enumerate(zip(closes, highs, strict=True))
    ]


@pytest.mark.unit
def test_scale_evaluates_max_times_factor() -> None:
    rows = _rows_with_high(closes=["95", "92", "98"], highs=["80", "100", "98"])
    # max(high_qfq over 3d) = 100; * 0.9 = 90; close=98 > 90 -> True
    pred = parse_predicate(
        {
            "op": "gt",
            "left": {"field": "close_qfq"},
            "right": {
                "scale": {
                    "inner": {"agg": "max", "field": "high_qfq", "window": {"days": 3}},
                    "factor": 0.9,
                }
            },
        },
        "/",
    )
    assert evaluate_predicate(rows, pred) is True


@pytest.mark.unit
def test_scale_compare_below_threshold() -> None:
    rows = _rows_with_high(closes=["80", "85", "88"], highs=["100", "100", "95"])
    # max=100, *0.9=90, close=88 < 90 -> False
    pred = parse_predicate(
        {
            "op": "gt",
            "left": {"field": "close_qfq"},
            "right": {
                "scale": {
                    "inner": {"agg": "max", "field": "high_qfq", "window": {"days": 3}},
                    "factor": 0.9,
                }
            },
        },
        "/",
    )
    assert evaluate_predicate(rows, pred) is False


@pytest.mark.unit
def test_scale_inner_na_propagates() -> None:
    # only 2 rows but window=5 -> aggregate yields _NA -> scale yields _NA -> compare False
    rows = _rows_with_high(closes=["95", "98"], highs=["100", "100"])
    pred = parse_predicate(
        {
            "op": "gt",
            "left": {"field": "close_qfq"},
            "right": {
                "scale": {
                    "inner": {"agg": "max", "field": "high_qfq", "window": {"days": 5}},
                    "factor": 0.9,
                }
            },
        },
        "/",
    )
    assert evaluate_predicate(rows, pred) is False


@pytest.mark.unit
def test_empty_rows_returns_false() -> None:
    pred = parse_predicate({"op": "gt", "left": {"const": 1}, "right": {"const": 0}}, "/")
    assert evaluate_predicate([], pred) is False
