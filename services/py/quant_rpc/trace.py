"""Trace-id propagation primitives (ipc-py-ts.md §5).

A single :data:`contextvars.ContextVar` carries the active trace id for the
current logical request. The Flight middleware (:mod:`quant_rpc.middleware`)
sets it from the incoming ``x-trace-id`` header before dispatch and resets
it after the call completes; handlers and the logging layer read it via
:func:`get_trace_id`.

The id is **not** generated for outbound work — that's the caller's
responsibility (NestJS gateway). The server only fills one in if the
client did not send one, so logs are never empty.
"""

from __future__ import annotations

import uuid
from contextvars import ContextVar
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from contextvars import Token

TRACE_HEADER: Final[str] = "x-trace-id"
"""Lowercase header / metadata key both sides agree on."""

_EMPTY: Final[str] = ""

_trace_id_var: ContextVar[str] = ContextVar("quant_rpc_trace_id", default=_EMPTY)


def get_trace_id() -> str:
    """Return the trace id bound to the current context, or ``""``."""
    return _trace_id_var.get()


def set_trace_id(value: str) -> Token[str]:
    """Bind ``value`` as the current trace id; returns a reset token."""
    return _trace_id_var.set(value)


def reset_trace_id(token: Token[str]) -> None:
    """Restore the previous trace id using ``token`` from :func:`set_trace_id`."""
    _trace_id_var.reset(token)


def new_trace_id() -> str:
    """Generate a fresh trace id (uuid4 hex, no dashes)."""
    return uuid.uuid4().hex
