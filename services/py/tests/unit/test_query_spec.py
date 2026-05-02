"""Unit tests for the QuerySpec algebra (smoke / immutability checks)."""

from __future__ import annotations

import dataclasses

import pytest
from quant_core.domain.types.query import (
    MATCH_ALL,
    And,
    Eq,
    In,
    Like,
    Or,
    QuerySpec,
    Range,
)


@pytest.mark.unit
class TestQuerySpecNodes:
    def test_match_all_has_no_filter_or_limit(self) -> None:
        assert MATCH_ALL.where is None
        assert MATCH_ALL.order_by == ()
        assert MATCH_ALL.limit is None

    def test_eq_is_frozen(self) -> None:
        node = Eq(field="code", value="600519.SH")
        with pytest.raises(dataclasses.FrozenInstanceError):
            node.field = "x"  # type: ignore[misc]  # frozen dataclass enforces this at runtime

    def test_in_holds_tuple_of_primitives(self) -> None:
        node = In(field="market", values=("SH", "SZ", "BJ"))
        assert node.values == ("SH", "SZ", "BJ")

    def test_range_allows_unbounded_sides(self) -> None:
        assert Range(field="ts", lo=None, hi=100).hi == 100
        assert Range(field="ts", lo=0, hi=None).lo == 0

    def test_like_pattern_preserved_verbatim(self) -> None:
        assert Like(field="name", pattern="%银行%").pattern == "%银行%"

    def test_and_or_compose(self) -> None:
        spec = QuerySpec(
            where=And(parts=(Eq(field="market", value="SH"), Or(parts=(Eq(field="x", value=1),)))),
            order_by=(("code", "asc"),),
            limit=10,
        )
        assert isinstance(spec.where, And)
        assert spec.limit == 10
