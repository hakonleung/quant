"""Unit tests for screen_compile.summarise."""

from __future__ import annotations

import pytest
from quant_core.domain.rules.screen_compile import summarise
from quant_core.domain.rules.screen_parse import parse_predicate


@pytest.mark.unit
def test_summary_collects_columns_and_window() -> None:
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
    summary = summarise(pred)
    assert summary.columns == frozenset({"close_qfq", "ma5"})
    assert summary.lookback_days == 5


@pytest.mark.unit
def test_summary_period_return_widens_lookback() -> None:
    pred = parse_predicate(
        {"op": "gt", "left": {"period_return": {"days": 20}}, "right": {"const": 0.30}}, "/"
    )
    summary = summarise(pred)
    assert "close_qfq" in summary.columns
    assert summary.lookback_days == 21


@pytest.mark.unit
def test_summary_compare_only_lookback_one() -> None:
    pred = parse_predicate({"op": "gt", "left": {"field": "close_qfq"}, "right": {"const": 1}}, "/")
    summary = summarise(pred)
    assert summary.lookback_days == 1
