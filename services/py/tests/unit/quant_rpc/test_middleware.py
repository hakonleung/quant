"""Unit tests for the trace-id Flight middleware factory."""

from __future__ import annotations

import pytest
from quant_rpc.middleware import TraceMiddleware, TraceMiddlewareFactory
from quant_rpc.trace import TRACE_HEADER


@pytest.mark.unit
class TestTraceMiddlewareFactory:
    def test_uses_client_supplied_trace_id(self) -> None:
        f = TraceMiddlewareFactory()
        mw = f.start_call(info=None, headers={TRACE_HEADER: ["from-client"]})
        assert mw.trace_id == "from-client"

    def test_synthesises_trace_id_when_absent(self) -> None:
        f = TraceMiddlewareFactory()
        mw = f.start_call(info=None, headers={})
        assert len(mw.trace_id) == 32
        int(mw.trace_id, 16)

    def test_header_lookup_is_case_insensitive(self) -> None:
        f = TraceMiddlewareFactory()
        mw = f.start_call(info=None, headers={"X-Trace-Id": ["upper"]})
        assert mw.trace_id == "upper"

    def test_empty_header_value_falls_back_to_synthetic(self) -> None:
        f = TraceMiddlewareFactory()
        mw = f.start_call(info=None, headers={TRACE_HEADER: []})
        assert len(mw.trace_id) == 32

    def test_sending_headers_echoes_trace_id(self) -> None:
        mw = TraceMiddleware("trace-abc")
        assert mw.sending_headers() == {TRACE_HEADER: "trace-abc"}

    def test_call_completed_is_a_noop(self) -> None:
        mw = TraceMiddleware("trace-abc")
        mw.call_completed(None)
        mw.call_completed(RuntimeError("boom"))
