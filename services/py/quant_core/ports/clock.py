"""Clock port — abstracts ``datetime.now`` so business code stays deterministic.

Per CLAUDE.md §2.6: time and randomness must be injected, not read from
globals. ``Clock`` is a ``Protocol`` so business code can accept either the
real ``SystemClock`` (in ``quant_core.adapters.clock``) or a test double
(``FrozenClock`` in ``tests/_util/clock.py``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from datetime import datetime


@runtime_checkable
class Clock(Protocol):
    """A wall-clock source. All times must be tz-aware UTC ``datetime``."""

    def now(self) -> datetime:
        """Return the current time as a tz-aware UTC ``datetime``."""
        ...
