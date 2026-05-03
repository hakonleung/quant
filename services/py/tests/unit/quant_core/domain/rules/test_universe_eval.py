"""Unit tests for the universe-screen DSL parser + evaluator."""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from quant_core.domain.rules.universe_eval import evaluate_universe
from quant_core.domain.rules.universe_parse import parse_universe_plan
from quant_core.domain.types.stock import StockMeta
from quant_core.errors import QuantError


def _meta(
    code: str,
    name: str,
    *,
    industries: str = "",
    list_date: date = date(2020, 1, 1),
    float_pct: str = "1",
) -> StockMeta:
    return StockMeta(
        code=code,
        name=name,
        name_pinyin="",
        industries=industries,
        list_date=list_date,
        float_pct=Decimal(float_pct),
        updated_at=datetime(2026, 5, 1, tzinfo=UTC),
    )


@pytest.mark.unit
def test_filter_drops_st_and_beijing_exchange() -> None:
    plan = parse_universe_plan(
        {
            "asof": "2026-05-01",
            "expr": {
                "op": "and",
                "args": [
                    {"op": "eq", "left": {"field": "is_st"}, "right": {"const": False}},
                    {
                        "op": "not_starts_with",
                        "left": {"field": "code"},
                        "right": {"const": "8"},
                    },
                    {
                        "op": "not_starts_with",
                        "left": {"field": "code"},
                        "right": {"const": "920"},
                    },
                ],
            },
        }
    )
    metas = [
        _meta("600519", "贵州茅台"),
        _meta("000001", "ST平安"),
        _meta("832000", "北交所A"),
        _meta("920002", "北交所B"),
    ]
    survivors = [m.code for m in evaluate_universe(plan, metas)]
    assert survivors == ["600519"]


@pytest.mark.unit
def test_listed_days_filter() -> None:
    plan = parse_universe_plan(
        {
            "asof": "2026-05-01",
            "expr": {
                "op": "gt",
                "left": {"field": "listed_days"},
                "right": {"const": 90},
            },
        }
    )
    metas = [
        _meta("600519", "老股", list_date=date(2020, 1, 1)),  # >90d
        _meta("000003", "新股", list_date=date(2026, 4, 30)),  # <90d
    ]
    survivors = [m.code for m in evaluate_universe(plan, metas)]
    assert survivors == ["600519"]


@pytest.mark.unit
def test_industries_contains() -> None:
    plan = parse_universe_plan(
        {
            "asof": "2026-05-01",
            "expr": {
                "op": "contains",
                "left": {"field": "industries"},
                "right": {"const": "白酒"},
            },
        }
    )
    metas = [
        _meta("600519", "贵州茅台", industries="食品饮料,白酒"),
        _meta("000001", "平安银行", industries="银行"),
    ]
    survivors = [m.code for m in evaluate_universe(plan, metas)]
    assert survivors == ["600519"]


@pytest.mark.unit
def test_parse_invalid_field_rejected() -> None:
    with pytest.raises(QuantError, match="unknown universe field"):
        parse_universe_plan(
            {
                "asof": "2026-05-01",
                "expr": {"op": "eq", "left": {"field": "ZZZ"}, "right": {"const": 1}},
            }
        )


@pytest.mark.unit
def test_parse_is_st_requires_bool() -> None:
    with pytest.raises(QuantError, match="is_st const must be a bool"):
        parse_universe_plan(
            {
                "asof": "2026-05-01",
                "expr": {"op": "eq", "left": {"field": "is_st"}, "right": {"const": "yes"}},
            }
        )


@pytest.mark.unit
def test_or_logical_combines_two_branches() -> None:
    plan = parse_universe_plan(
        {
            "asof": "2026-05-01",
            "expr": {
                "op": "or",
                "args": [
                    {
                        "op": "starts_with",
                        "left": {"field": "code"},
                        "right": {"const": "60"},
                    },
                    {
                        "op": "starts_with",
                        "left": {"field": "code"},
                        "right": {"const": "00"},
                    },
                ],
            },
        }
    )
    metas = [_meta("600000", "A"), _meta("000001", "B"), _meta("832000", "C")]
    survivors = [m.code for m in evaluate_universe(plan, metas)]
    assert survivors == ["600000", "000001"]
