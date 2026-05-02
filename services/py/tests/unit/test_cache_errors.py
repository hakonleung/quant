"""Unit tests for the CacheError hierarchy + ErrorCode defaults."""

from __future__ import annotations

import pytest
from quant_cache.errors import (
    CacheBackendUnavailable,
    CacheCorrupted,
    CacheError,
    CacheKeyNotFound,
)
from quant_core.errors import QuantError


@pytest.mark.unit
class TestCacheErrorHierarchy:
    def test_all_subclasses_inherit_from_quant_error(self) -> None:
        for cls in (CacheError, CacheKeyNotFound, CacheCorrupted, CacheBackendUnavailable):
            assert issubclass(cls, QuantError)

    @pytest.mark.parametrize(
        ("cls", "expected_code"),
        [
            (CacheError, "INTERNAL"),
            (CacheKeyNotFound, "CACHE_KEY_NOT_FOUND"),
            (CacheCorrupted, "CACHE_CORRUPTED"),
            (CacheBackendUnavailable, "CACHE_BACKEND_UNAVAILABLE"),
        ],
    )
    def test_default_code_matches_class(self, cls: type[CacheError], expected_code: str) -> None:
        err = cls("boom")
        assert err.code == expected_code

    def test_caller_can_override_code(self) -> None:
        err = CacheError("boom", code="NOT_FOUND")
        assert err.code == "NOT_FOUND"

    def test_details_are_immutable(self) -> None:
        err = CacheError("boom", {"path": "/tmp/x"})
        assert dict(err.details) == {"path": "/tmp/x"}
        with pytest.raises(TypeError):
            err.details["path"] = "evil"  # type: ignore[index]  # MappingProxyType disallows assignment at runtime
