"""Smoke tests for `quant_core.errors.QuantError`."""

from __future__ import annotations

import pytest
from quant_core.errors import QuantError


@pytest.mark.unit
class TestQuantError:
    def test_init_exposes_code_message_and_details(self) -> None:
        err = QuantError("STOCK_NOT_FOUND", "no such stock", {"code": "600519.SH"})
        assert err.code == "STOCK_NOT_FOUND"
        assert str(err) == "no such stock"
        assert dict(err.details) == {"code": "600519.SH"}

    def test_init_with_no_details_defaults_to_empty_mapping(self) -> None:
        err = QuantError("INTERNAL", "oops")
        assert dict(err.details) == {}

    def test_details_are_immutable(self) -> None:
        err = QuantError("X", "x", {"a": 1})
        with pytest.raises(TypeError):
            err.details["a"] = 999  # type: ignore[index]  # MappingProxyType rejects assignment at runtime; Mapping[str, object] does not encode this in the type system

    def test_caller_mutation_does_not_leak_into_error(self) -> None:
        payload = {"a": 1}
        err = QuantError("X", "x", payload)
        payload["a"] = 999
        assert dict(err.details) == {"a": 1}

    def test_is_subclass_of_exception(self) -> None:
        err = QuantError("X", "x")
        assert isinstance(err, Exception)
