"""Unit tests for ``QuantFlightServer`` dispatch logic.

The contract test ``test_flight_server.py`` exercises the whole server
through a real client + daemon thread, but pyarrow's Flight server runs
inside a C++/Cython thread that ``coverage.py`` cannot trace. We re-cover
the dispatch logic here by calling the server methods directly with a
fake ``ServerCallContext``.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pyarrow as pa
import pytest
from pyarrow import flight
from quant_core.errors import QuantError
from quant_rpc import HandlerRegistry, QuantFlightServer, get_trace_id
from quant_rpc.middleware import TraceMiddleware, TraceMiddlewareFactory

if TYPE_CHECKING:
    from collections.abc import Mapping


class _FakeContext:
    """Minimal stand-in for ``flight.ServerCallContext``."""

    def __init__(self, trace_id: str | None) -> None:
        self._mw = TraceMiddleware(trace_id) if trace_id is not None else None

    def get_middleware(self, key: str) -> TraceMiddleware | None:
        if key == TraceMiddlewareFactory.KEY:
            return self._mw
        return None


class _SeenTraceHandler:
    op = "trace-probe"
    schema = pa.schema([("trace_id", pa.string())])

    def __init__(self) -> None:
        self.seen: str = ""

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        self.seen = get_trace_id()
        return pa.table({"trace_id": [self.seen]}, schema=self.schema)


class _RaisingHandler:
    op = "raises"
    schema = pa.schema([("x", pa.int64())])

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        raise QuantError("DSL_INVALID", "bad query", {"why": "test"})


def _make_server() -> tuple[QuantFlightServer, _SeenTraceHandler]:
    reg = HandlerRegistry()
    seen = _SeenTraceHandler()
    reg.register(seen)
    reg.register(_RaisingHandler())
    return QuantFlightServer(reg, location="grpc://127.0.0.1:0"), seen


def _command(op: str, args: dict[str, object] | None = None) -> bytes:
    return json.dumps({"op": op, "args": args or {}}).encode("utf-8")


@pytest.mark.unit
class TestServerDispatchHappyPath:
    def test_get_flight_info_returns_handler_schema(self) -> None:
        server, _ = _make_server()
        descriptor = flight.FlightDescriptor.for_command(_command("trace-probe"))
        info = server.get_flight_info(_FakeContext("tid"), descriptor)
        assert info.schema == _SeenTraceHandler().schema
        assert info.endpoints[0].ticket.ticket == descriptor.command

    def test_do_get_invokes_handler_with_trace_id_bound(self) -> None:
        server, seen = _make_server()
        ticket = flight.Ticket(_command("trace-probe"))
        # `RecordBatchStream` is a write-only sink for the Flight transport;
        # we don't decode it here. The handler captures what it saw.
        server.do_get(_FakeContext("tid-xyz"), ticket)
        assert seen.seen == "tid-xyz"

    def test_trace_id_is_empty_when_middleware_absent(self) -> None:
        server, seen = _make_server()
        ticket = flight.Ticket(_command("trace-probe"))
        server.do_get(_FakeContext(None), ticket)
        assert seen.seen == ""

    def test_trace_id_resets_after_dispatch(self) -> None:
        server, _ = _make_server()
        ticket = flight.Ticket(_command("trace-probe"))
        server.do_get(_FakeContext("during-call"), ticket)
        assert get_trace_id() == ""


@pytest.mark.unit
class TestServerDispatchErrors:
    def test_path_descriptor_rejected(self) -> None:
        server, _ = _make_server()
        bad = flight.FlightDescriptor.for_path("anything")
        with pytest.raises(flight.FlightServerError):
            server.get_flight_info(_FakeContext("t"), bad)

    def test_unknown_op_in_get_flight_info(self) -> None:
        server, _ = _make_server()
        descriptor = flight.FlightDescriptor.for_command(_command("nope"))
        with pytest.raises(flight.FlightServerError):
            server.get_flight_info(_FakeContext("t"), descriptor)

    def test_handler_quant_error_in_do_get(self) -> None:
        server, _ = _make_server()
        ticket = flight.Ticket(_command("raises"))
        with pytest.raises(flight.FlightServerError):
            server.do_get(_FakeContext("t"), ticket).read_all()

    def test_non_utf8_command_rejected(self) -> None:
        server, _ = _make_server()
        descriptor = flight.FlightDescriptor.for_command(b"\xff\xfe")
        with pytest.raises(flight.FlightServerError):
            server.get_flight_info(_FakeContext("t"), descriptor)

    def test_command_must_decode_to_object(self) -> None:
        server, _ = _make_server()
        descriptor = flight.FlightDescriptor.for_command(b"[1, 2, 3]")
        with pytest.raises(flight.FlightServerError):
            server.get_flight_info(_FakeContext("t"), descriptor)

    def test_command_missing_op(self) -> None:
        server, _ = _make_server()
        descriptor = flight.FlightDescriptor.for_command(b'{"args": {}}')
        with pytest.raises(flight.FlightServerError):
            server.get_flight_info(_FakeContext("t"), descriptor)

    def test_command_op_not_string(self) -> None:
        server, _ = _make_server()
        descriptor = flight.FlightDescriptor.for_command(b'{"op": 1}')
        with pytest.raises(flight.FlightServerError):
            server.get_flight_info(_FakeContext("t"), descriptor)

    def test_command_args_not_object(self) -> None:
        server, _ = _make_server()
        descriptor = flight.FlightDescriptor.for_command(b'{"op": "trace-probe", "args": 1}')
        with pytest.raises(flight.FlightServerError):
            server.get_flight_info(_FakeContext("t"), descriptor)
