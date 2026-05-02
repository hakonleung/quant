"""Smoke tests for `quant_core.domain.pure.greet` (CLAUDE.md §3.3 scenarios)."""

from __future__ import annotations

import pytest
from quant_core.domain.pure.greet import greet
from quant_core.errors import QuantError


@pytest.mark.unit
class TestGreet:
    def test_greet_with_typical_name_returns_hello_world(self) -> None:
        assert greet("World") == "Hello, World"

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("A", "Hello, A"),
            ("Quant", "Hello, Quant"),
            ("你好", "Hello, 你好"),
        ],
    )
    def test_greet_with_short_or_unicode_name_returns_expected(
        self, name: str, expected: str
    ) -> None:
        assert greet(name) == expected

    def test_greet_with_empty_name_raises_quant_error(self) -> None:
        with pytest.raises(QuantError) as exc:
            greet("")
        assert exc.value.code == "INVALID_ARGUMENT"

    def test_greet_is_deterministic(self) -> None:
        assert greet("x") == greet("x")
