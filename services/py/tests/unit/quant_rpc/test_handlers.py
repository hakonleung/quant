"""Unit tests for :class:`HandlerRegistry`."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pyarrow as pa
import pytest
from quant_core.errors import QuantError
from quant_rpc import HandlerRegistry

if TYPE_CHECKING:
    from collections.abc import Mapping


class _StaticHandler:
    def __init__(self, op: str) -> None:
        self._op = op
        self.schema = pa.schema([("x", pa.int64())])

    @property
    def op(self) -> str:
        return self._op

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        return pa.table({"x": [1]}, schema=self.schema)


@pytest.mark.unit
class TestHandlerRegistry:
    def test_register_then_lookup(self) -> None:
        reg = HandlerRegistry()
        h = _StaticHandler("foo")
        reg.register(h)
        assert reg.lookup("foo") is h

    def test_duplicate_register_raises_invalid_argument(self) -> None:
        reg = HandlerRegistry()
        reg.register(_StaticHandler("foo"))
        with pytest.raises(QuantError) as excinfo:
            reg.register(_StaticHandler("foo"))
        assert excinfo.value.code == "INVALID_ARGUMENT"

    def test_lookup_unknown_raises_not_found_with_registered_list(self) -> None:
        reg = HandlerRegistry()
        reg.register(_StaticHandler("alpha"))
        reg.register(_StaticHandler("beta"))
        with pytest.raises(QuantError) as excinfo:
            reg.lookup("gamma")
        assert excinfo.value.code == "NOT_FOUND"
        assert excinfo.value.details["registered"] == ["alpha", "beta"]

    def test_contains_string_check(self) -> None:
        reg = HandlerRegistry()
        reg.register(_StaticHandler("foo"))
        assert "foo" in reg
        assert "bar" not in reg
        assert 123 not in reg  # non-string keys never match

    def test_ops_returns_sorted_tuple(self) -> None:
        reg = HandlerRegistry()
        for op in ("zeta", "alpha", "mu"):
            reg.register(_StaticHandler(op))
        assert reg.ops() == ("alpha", "mu", "zeta")
