"""Arrow Flight server (ipc-py-ts.md §3, §5).

Routes every Flight call through the JSON descriptor protocol::

    FlightDescriptor.for_command(b'{"op": "<name>", "args": {...}}')

Only ``do_get`` and ``get_flight_info`` are implemented in this milestone;
``do_put`` / ``do_action`` raise ``NotImplementedError`` (inherited) and
will be added when the first feature actually needs them (per CLAUDE.md
§2.5.2 — no abstraction without a caller).

Errors raised by handlers are converted via
:func:`quant_rpc.errors.flight_error_from_quant_error` so the caller can
recover ``ErrorCode`` and trace_id from the message envelope.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from typing import TYPE_CHECKING, Final

from pyarrow import flight
from quant_core.errors import QuantError

from quant_rpc.errors import flight_error_from_quant_error
from quant_rpc.middleware import TraceMiddleware, TraceMiddlewareFactory
from quant_rpc.trace import reset_trace_id, set_trace_id

if TYPE_CHECKING:
    from collections.abc import Iterator

    from quant_rpc.handlers import FlightHandler, HandlerRegistry


_DEFAULT_LOCATION: Final[str] = "grpc://127.0.0.1:0"


class QuantFlightServer(flight.FlightServerBase):
    """Flight server that dispatches by op name to a :class:`HandlerRegistry`."""

    def __init__(
        self,
        registry: HandlerRegistry,
        *,
        location: str = _DEFAULT_LOCATION,
    ) -> None:
        super().__init__(
            location,
            middleware={TraceMiddlewareFactory.KEY: TraceMiddlewareFactory()},
        )
        self._registry = registry

    # -- internal helpers ----------------------------------------------

    def _trace_id(self, context: flight.ServerCallContext) -> str:
        mw = context.get_middleware(TraceMiddlewareFactory.KEY)
        if isinstance(mw, TraceMiddleware):
            return mw.trace_id
        return ""

    @contextmanager
    def _bind_trace_id(self, trace_id: str) -> Iterator[None]:
        """Bind trace_id to the contextvar for the duration of dispatch.

        Done in the server (not the middleware) so the bind/reset happen in
        the same ``contextvars.Context`` — pyarrow uses different contexts
        for ``start_call`` vs the actual handler invocation.
        """
        token = set_trace_id(trace_id)
        try:
            yield
        finally:
            reset_trace_id(token)

    def _parse_command(self, command: bytes) -> tuple[str, dict[str, object]]:
        try:
            doc = json.loads(command.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise QuantError(
                "INVALID_ARGUMENT",
                "flight descriptor command is not valid utf-8 json",
            ) from exc
        if not isinstance(doc, dict):
            raise QuantError(
                "INVALID_ARGUMENT",
                "flight descriptor command must decode to an object",
            )
        op = doc.get("op")
        if not isinstance(op, str) or not op:
            raise QuantError(
                "INVALID_ARGUMENT",
                "flight descriptor command missing 'op' string",
            )
        args_raw = doc.get("args", {})
        if not isinstance(args_raw, dict):
            raise QuantError(
                "INVALID_ARGUMENT",
                "flight descriptor 'args' must be an object",
            )
        return op, dict(args_raw)

    def _resolve(self, command: bytes) -> tuple[FlightHandler, dict[str, object]]:
        op, args = self._parse_command(command)
        handler = self._registry.lookup(op)
        return handler, args

    # -- FlightServerBase overrides -------------------------------------

    def get_flight_info(
        self,
        context: flight.ServerCallContext,
        descriptor: flight.FlightDescriptor,
    ) -> flight.FlightInfo:
        trace_id = self._trace_id(context)
        with self._bind_trace_id(trace_id):
            if descriptor.command is None:
                raise flight_error_from_quant_error(
                    QuantError(
                        "INVALID_ARGUMENT",
                        "only command descriptors are supported (got path)",
                    ),
                    trace_id,
                )
            try:
                handler, _args = self._resolve(descriptor.command)
            except QuantError as err:
                raise flight_error_from_quant_error(err, trace_id) from err
            endpoint = flight.FlightEndpoint(
                ticket=flight.Ticket(descriptor.command),
                locations=[],
            )
            return flight.FlightInfo(handler.schema, descriptor, [endpoint], -1, -1)

    def do_get(
        self,
        context: flight.ServerCallContext,
        ticket: flight.Ticket,
    ) -> flight.RecordBatchStream:
        trace_id = self._trace_id(context)
        with self._bind_trace_id(trace_id):
            try:
                handler, args = self._resolve(ticket.ticket)
                table = handler.execute(args)
            except QuantError as err:
                raise flight_error_from_quant_error(err, trace_id) from err
            return flight.RecordBatchStream(table)
