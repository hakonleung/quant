"""Cache port for :class:`TaAnalysis` (beta).

A TA payload is small and one-per-(code, asof) — no aggregation case to
key separately. We mirror the sentiment cache shape: ``get`` returns a
fresh hit or ``None``; ``put`` overwrites. Adapters MUST treat any row
whose ``schema_version`` differs from
:data:`quant_core.domain.types.ta.SCHEMA_VERSION` or whose effective
expiry is in the past as a miss.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from datetime import date

    from quant_core.domain.types.ta import TaAnalysis


@runtime_checkable
class TaCache(Protocol):
    """Per-code cache for :class:`TaAnalysis`."""

    def get(self, code: str, asof: date) -> TaAnalysis | None:
        """Return a fresh cached analysis or ``None`` on miss."""
        ...

    def put(self, value: TaAnalysis) -> None:
        """Write a payload. Idempotent — overwrites any existing row for
        the same ``(code, asof)``."""
        ...

    def invalidate(self, code: str) -> None:
        """Drop every cached payload for ``code`` (force-refresh affordance)."""
        ...
