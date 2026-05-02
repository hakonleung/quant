"""Unit tests for the trace_id contextvar primitives."""

from __future__ import annotations

import pytest
from quant_rpc import get_trace_id, new_trace_id, reset_trace_id, set_trace_id


@pytest.mark.unit
class TestTraceContext:
    def test_default_is_empty(self) -> None:
        assert get_trace_id() == ""

    def test_set_and_get(self) -> None:
        token = set_trace_id("abc")
        try:
            assert get_trace_id() == "abc"
        finally:
            reset_trace_id(token)

    def test_reset_restores_previous(self) -> None:
        outer = set_trace_id("outer")
        try:
            inner = set_trace_id("inner")
            assert get_trace_id() == "inner"
            reset_trace_id(inner)
            assert get_trace_id() == "outer"
        finally:
            reset_trace_id(outer)

    def test_new_trace_id_is_32_hex_chars(self) -> None:
        tid = new_trace_id()
        assert len(tid) == 32
        int(tid, 16)  # parses as hex

    def test_new_trace_id_is_unique(self) -> None:
        ids = {new_trace_id() for _ in range(100)}
        assert len(ids) == 100
