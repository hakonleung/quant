"""Arrow Flight RPC layer (ipc-py-ts.md §3-§5).

Public surface:

* :class:`FlightHandler` — Protocol for op handlers.
* :class:`HandlerRegistry` — op-name → handler dispatch table.
* :class:`QuantFlightServer` — `FlightServerBase` subclass routing
  ``do_get`` / ``get_flight_info`` to the registry, with trace_id
  middleware and ``QuantError`` → ``FlightServerError`` mapping.
* trace utilities (:func:`get_trace_id`, :func:`new_trace_id`,
  :data:`TRACE_HEADER`).
"""

from quant_rpc.errors import flight_error_from_quant_error, parse_flight_error_payload
from quant_rpc.handlers import FlightHandler, HandlerRegistry
from quant_rpc.server import QuantFlightServer
from quant_rpc.trace import (
    TRACE_HEADER,
    get_trace_id,
    new_trace_id,
    reset_trace_id,
    set_trace_id,
)

__all__ = [
    "TRACE_HEADER",
    "FlightHandler",
    "HandlerRegistry",
    "QuantFlightServer",
    "flight_error_from_quant_error",
    "get_trace_id",
    "new_trace_id",
    "parse_flight_error_payload",
    "reset_trace_id",
    "set_trace_id",
]
