"""``SystemClock`` — production adapter for the :class:`Clock` port."""

from __future__ import annotations

from datetime import UTC, datetime


class SystemClock:
    """Real wall clock — thin adapter over :func:`datetime.now`."""

    __slots__ = ()

    def now(self) -> datetime:
        return datetime.now(tz=UTC)
