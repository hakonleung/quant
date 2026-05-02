"""Domain types describing a data source's runtime status.

Sources are external SDK wrappers (tushare, akshare, ...) so the domain
needs a way to ask "are you reachable, and how stressed are you" without
caring which SDK answers. Both fields are optional because some sources
expose them and others do not.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SourceHealth:
    """Snapshot of a source's reachability + capacity at a point in time.

    Attributes:
        name: Stable source identifier ("tushare", "akshare", ...).
        available: True iff the most recent probe succeeded.
        latency_ms: Round-trip time of the probe; ``None`` if it failed.
        quota_remaining: Provider-reported remaining quota for the day,
            or ``None`` if the provider does not expose one.
        last_error: Short, human-readable failure description; ``None``
            on success.
    """

    name: str
    available: bool
    latency_ms: int | None
    quota_remaining: int | None
    last_error: str | None
