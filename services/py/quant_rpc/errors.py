"""``QuantError`` ↔ ``flight.FlightServerError`` mapping (ipc-py-ts.md §4).

Pyarrow Flight does not surface a structured error code field — only a
single ``message`` string. We embed the structured payload (code, human
message, trace id, details) as JSON in that string and document the
shape so the NestJS client can parse it back. The wire format is:

.. code-block:: json

    {
      "code": "STOCK_NOT_FOUND",
      "message": "no such stock: 999999",
      "trace_id": "abcdef0123",
      "details": {"code": "999999"}
    }

Both sides reference the same closed ``ErrorCode`` literal generated from
``proto/errors.json``, so the string is a stable contract — see
``quant_core.contracts.errors``.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Final, TypedDict

from pyarrow import flight

if TYPE_CHECKING:
    from quant_core.errors import QuantError

_ENVELOPE_VERSION: Final[int] = 1


class FlightErrorPayload(TypedDict):
    """Shape of the JSON we tunnel through ``FlightServerError.message``."""

    v: int
    code: str
    message: str
    trace_id: str
    details: dict[str, object]


def flight_error_from_quant_error(err: QuantError, trace_id: str) -> flight.FlightServerError:
    """Wrap ``err`` in a ``FlightServerError`` carrying a structured payload."""
    payload: FlightErrorPayload = {
        "v": _ENVELOPE_VERSION,
        "code": err.code,
        "message": str(err),
        "trace_id": trace_id,
        "details": dict(err.details),
    }
    return flight.FlightServerError(json.dumps(payload, separators=(",", ":")))


def parse_flight_error_payload(message: str) -> FlightErrorPayload | None:
    """Return the structured payload from a ``FlightServerError.message``.

    Returns ``None`` if the message is not a Quant envelope (e.g. raised by
    pyarrow itself before our handler ran). Callers should treat that as
    code ``INTERNAL`` with the raw message as the human description.
    """
    # gRPC prefixes server errors with "Flight returned <status> error, with
    # message: " and may suffix ". Detail: ...". Locate the JSON object with
    # raw_decode so trailing junk after the envelope is tolerated.
    brace = message.find("{")
    if brace == -1:
        return None
    try:
        doc, _consumed = json.JSONDecoder().raw_decode(message[brace:])
    except json.JSONDecodeError:
        return None
    if not isinstance(doc, dict) or doc.get("v") != _ENVELOPE_VERSION:
        return None
    code = doc.get("code")
    msg = doc.get("message")
    trace_id = doc.get("trace_id")
    details = doc.get("details")
    if (
        not isinstance(code, str)
        or not isinstance(msg, str)
        or not isinstance(trace_id, str)
        or not isinstance(details, dict)
    ):
        return None
    return FlightErrorPayload(
        v=_ENVELOPE_VERSION,
        code=code,
        message=msg,
        trace_id=trace_id,
        details=dict(details),
    )


__all__ = [
    "FlightErrorPayload",
    "flight_error_from_quant_error",
    "parse_flight_error_payload",
]


# Re-export used by the server module to keep type stubs happy.
_ErrorCode = "ErrorCode"
