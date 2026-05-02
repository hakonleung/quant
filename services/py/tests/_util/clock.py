"""Deterministic clock fixture for tests (CLAUDE.md §2.6, §3.4)."""

from __future__ import annotations

from datetime import datetime, timedelta


class FrozenClock:
    """Manually-advanced clock used to make TTL / now-dependent code testable.

    Args:
        start: Initial time. Must be tz-aware.

    Raises:
        ValueError: if ``start`` is naive.
    """

    __slots__ = ("_now",)

    def __init__(self, start: datetime) -> None:
        if start.tzinfo is None:
            raise ValueError("FrozenClock requires a tz-aware datetime")
        self._now = start

    def now(self) -> datetime:
        return self._now

    def advance(self, *, seconds: float) -> None:
        """Move the clock forward by ``seconds`` (negative values rewind)."""
        self._now = self._now + timedelta(seconds=seconds)
