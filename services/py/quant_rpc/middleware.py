"""Flight server middleware: trace_id extraction (ipc-py-ts.md §5).

The middleware's job is narrow: pull ``x-trace-id`` from the inbound
headers (or generate one), expose it on the per-call object, and echo it
back via response headers. **Binding to the contextvar happens in the
server's dispatch path**, not here — pyarrow's middleware lifecycle uses
different ``contextvars.Context`` instances for ``start_call`` vs
``call_completed`` and ``do_get``, so a token created in ``start_call``
cannot be reset later. Doing the bind/reset inside one server method
keeps everything in a single context.
"""

from __future__ import annotations

from pyarrow import flight

from quant_rpc.trace import TRACE_HEADER, new_trace_id


class TraceMiddleware(flight.ServerMiddleware):
    """Per-call middleware holding the resolved trace_id."""

    __slots__ = ("_trace_id",)

    def __init__(self, trace_id: str) -> None:
        self._trace_id = trace_id

    @property
    def trace_id(self) -> str:
        return self._trace_id

    def sending_headers(self) -> dict[str, str]:
        return {TRACE_HEADER: self._trace_id}

    def call_completed(self, exception: BaseException | None) -> None:
        # No-op — see module docstring on why context binding is in the server.
        return


class TraceMiddlewareFactory(flight.ServerMiddlewareFactory):
    """Resolves a trace_id for every inbound RPC."""

    KEY = "trace"

    def start_call(
        self,
        info: flight.CallInfo,
        headers: dict[str, list[str]],
    ) -> TraceMiddleware:
        trace_id = _first_header(headers, TRACE_HEADER) or new_trace_id()
        return TraceMiddleware(trace_id)


def _first_header(headers: dict[str, list[str]], name: str) -> str | None:
    """Header lookup that tolerates the case-folded keys grpc gives us."""
    for key, values in headers.items():
        if key.lower() == name and values:
            return values[0]
    return None
