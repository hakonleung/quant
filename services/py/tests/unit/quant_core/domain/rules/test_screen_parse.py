"""Unit tests for the screening DSL parser (RFC 0001 §6)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from quant_core.domain.rules.screen_parse import parse_plan, parse_predicate
from quant_core.domain.types.screen import (
    Aggregate,
    Compare,
    Consecutive,
    Const,
    Exists,
    Field,
    ForAll,
    Logical,
    PeriodReturn,
    Scale,
)
from quant_core.errors import QuantError


@pytest.mark.unit
def test_parse_plan_minimal() -> None:
    plan = parse_plan(
        {
            "asof": "2026-04-30",
            "expr": {
                "op": "gt",
                "left": {"field": "close_qfq"},
                "right": {"field": "ma5"},
            },
        }
    )
    assert plan.asof == date(2026, 4, 30)
    assert isinstance(plan.expr, Compare)
    assert plan.expr.op == "gt"


@pytest.mark.unit
def test_parse_for_all_close_above_ma5() -> None:
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
        "/expr",
    )
    assert isinstance(pred, ForAll)
    assert pred.days == 5
    assert isinstance(pred.predicate, Compare)


@pytest.mark.unit
def test_parse_aggregate_mean_turnover() -> None:
    pred = parse_predicate(
        {
            "op": "lt",
            "left": {"agg": "mean", "field": "turnover_rate", "window": {"days": 10}},
            "right": {"const": 0.10},
        },
        "/expr",
    )
    assert isinstance(pred, Compare)
    assert isinstance(pred.left, Aggregate)
    assert pred.left.days == 10
    assert isinstance(pred.right, Const)


@pytest.mark.unit
def test_parse_period_return() -> None:
    pred = parse_predicate(
        {
            "op": "gt",
            "left": {"period_return": {"days": 20}},
            "right": {"const": 0.30},
        },
        "/expr",
    )
    assert isinstance(pred, Compare)
    assert isinstance(pred.left, PeriodReturn)
    assert pred.left.days == 20


@pytest.mark.unit
def test_parse_consecutive() -> None:
    pred = parse_predicate(
        {
            "op": "consecutive",
            "min_len": 5,
            "predicate": {
                "op": "gt",
                "left": {"field": "pct_chg_qfq"},
                "right": {"const": 0.02},
            },
        },
        "/expr",
    )
    assert isinstance(pred, Consecutive)
    assert pred.min_len == 5


@pytest.mark.unit
def test_parse_indicator_collapses_to_field() -> None:
    pred = parse_predicate(
        {
            "op": "gt",
            "left": {"field": "close_qfq"},
            "right": {"indicator": "ma", "field": "close_qfq", "period": 20},
        },
        "/expr",
    )
    assert isinstance(pred, Compare)
    assert isinstance(pred.right, Field)
    assert pred.right.field == "ma20"


@pytest.mark.unit
@pytest.mark.parametrize(
    ("raw", "fragment"),
    [
        ({"op": "ZZZ"}, "unknown op"),
        ({"op": "gt", "left": {"field": "close_qfq"}, "right": {}}, "scalar must be one of"),
        (
            {
                "op": "for_all",
                "window": {"days": 0},
                "predicate": {
                    "op": "and",
                    "args": [{"op": "gt", "left": {"field": "close_qfq"}, "right": {"const": 1}}],
                },
            },
            "window.days must be a positive int",
        ),
        (
            {
                "op": "not",
                "args": [
                    {"op": "gt", "left": {"const": 1}, "right": {"const": 2}},
                    {"op": "gt", "left": {"const": 1}, "right": {"const": 2}},
                ],
            },
            "exactly one",
        ),
        ({"op": "gt", "left": {"const": True}, "right": {"const": 1}}, "not bool"),
        ({"op": "gt", "left": {"field": "ZZZ"}, "right": {"const": 1}}, "unknown field"),
    ],
)
def test_parse_invalid_raises(raw: dict[str, object], fragment: str) -> None:
    with pytest.raises(QuantError, match=fragment):
        parse_predicate(raw, "/expr")


@pytest.mark.unit
def test_parse_logical_and_or() -> None:
    pred = parse_predicate(
        {
            "op": "and",
            "args": [
                {"op": "gt", "left": {"field": "close_qfq"}, "right": {"const": 0}},
                {"op": "lt", "left": {"field": "close_qfq"}, "right": {"const": 1000}},
            ],
        },
        "/expr",
    )
    assert isinstance(pred, Logical)
    assert pred.op == "and"
    assert len(pred.args) == 2


@pytest.mark.unit
def test_parse_exists_window() -> None:
    pred = parse_predicate(
        {
            "op": "exists",
            "window": {"days": 3},
            "predicate": {"op": "gt", "left": {"field": "close_qfq"}, "right": {"const": 100}},
        },
        "/expr",
    )
    assert isinstance(pred, Exists)
    assert pred.days == 3


@pytest.mark.unit
def test_parse_scale_wraps_aggregate() -> None:
    pred = parse_predicate(
        {
            "op": "gt",
            "left": {"field": "close_qfq"},
            "right": {
                "scale": {
                    "inner": {"agg": "max", "field": "high_qfq", "window": {"days": 60}},
                    "factor": 0.9,
                }
            },
        },
        "/expr",
    )
    assert isinstance(pred, Compare)
    assert isinstance(pred.right, Scale)
    assert pred.right.factor == Decimal("0.9")
    assert isinstance(pred.right.inner, Aggregate)
    assert pred.right.inner.agg == "max"
    assert pred.right.inner.field == "high_qfq"
    assert pred.right.inner.days == 60


@pytest.mark.unit
def test_parse_scale_nested() -> None:
    pred = parse_predicate(
        {
            "op": "gt",
            "left": {"field": "close_qfq"},
            "right": {
                "scale": {
                    "inner": {
                        "scale": {
                            "inner": {"field": "ma20"},
                            "factor": 0.5,
                        }
                    },
                    "factor": 0.5,
                }
            },
        },
        "/expr",
    )
    assert isinstance(pred, Compare)
    outer = pred.right
    assert isinstance(outer, Scale)
    assert outer.factor == Decimal("0.5")
    assert isinstance(outer.inner, Scale)
    assert outer.inner.factor == Decimal("0.5")
    assert isinstance(outer.inner.inner, Field)


@pytest.mark.unit
@pytest.mark.parametrize(
    ("scale_raw", "fragment"),
    [
        ({"inner": {"field": "close_qfq"}}, "factor"),  # missing factor
        ({"factor": 0.9}, "inner"),  # missing inner
        ({"inner": {"field": "close_qfq"}, "factor": 0}, "must be > 0"),
        ({"inner": {"field": "close_qfq"}, "factor": -0.1}, "must be > 0"),
        ({"inner": {"field": "close_qfq"}, "factor": "abc"}, "Decimal"),
        ({"inner": {"field": "ZZZ"}, "factor": 0.9}, "unknown field"),
        ("not-a-dict", "object"),
    ],
)
def test_parse_scale_invalid(scale_raw: object, fragment: str) -> None:
    with pytest.raises(QuantError, match=fragment):
        parse_predicate(
            {
                "op": "gt",
                "left": {"field": "close_qfq"},
                "right": {"scale": scale_raw},
            },
            "/expr",
        )


@pytest.mark.unit
def test_parse_plan_rejects_relative_asof() -> None:
    with pytest.raises(QuantError, match="ISO YYYY-MM-DD"):
        parse_plan(
            {"asof": "today", "expr": {"op": "gt", "left": {"const": 1}, "right": {"const": 0}}}
        )
