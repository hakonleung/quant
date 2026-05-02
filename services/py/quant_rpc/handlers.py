"""Handler registry for Flight ops (ipc-py-ts.md §3).

Every Flight call carries a JSON descriptor of the form
``{"op": "<name>", "args": {...}}``. The server dispatches ``op`` to a
registered :class:`FlightHandler`; ``args`` is passed through verbatim.

Why a registry instead of subclassing the server: handlers are pure data
producers (``args -> Arrow Table``) and have no business knowing about
Flight transport. Tests can register an in-memory ``EchoHandler`` without
touching the server; production wiring assembles the registry in the
composition root.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    import pyarrow as pa


@runtime_checkable
class FlightHandler(Protocol):
    """One Flight op. Implementations are pure: same args → same table."""

    @property
    def op(self) -> str:
        """Stable op identifier; appears in every descriptor."""
        ...

    @property
    def schema(self) -> pa.Schema:
        """Arrow schema of the table returned by :meth:`execute`."""
        ...

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        """Run the op. Must return a table conforming to :attr:`schema`."""
        ...


class HandlerRegistry:
    """Op-name → handler dispatch.

    The registry refuses duplicate registrations (so config errors fail
    loudly at startup) and surfaces unknown ops as a typed
    :class:`QuantError` with code ``NOT_FOUND``.
    """

    __slots__ = ("_handlers",)

    def __init__(self) -> None:
        self._handlers: dict[str, FlightHandler] = {}

    def register(self, handler: FlightHandler) -> None:
        op = handler.op
        if op in self._handlers:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"op already registered: {op!r}",
                {"op": op},
            )
        self._handlers[op] = handler

    def lookup(self, op: str) -> FlightHandler:
        try:
            return self._handlers[op]
        except KeyError as exc:
            raise QuantError(
                "NOT_FOUND",
                f"unknown op: {op!r}",
                {"op": op, "registered": sorted(self._handlers)},
            ) from exc

    def __contains__(self, op: object) -> bool:
        return isinstance(op, str) and op in self._handlers

    def ops(self) -> tuple[str, ...]:
        return tuple(sorted(self._handlers))
