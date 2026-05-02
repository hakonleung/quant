"""Helpers shared by every concrete :class:`StockMetaSource` adapter."""

from __future__ import annotations

import importlib
import time
from typing import TYPE_CHECKING

from quant_core.domain.types.source import SourceHealth
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime


def lazy_import(module: str) -> object | None:
    """Import ``module`` if available, else return ``None``.

    Source adapters call this to keep heavy SDK deps optional. A
    ``None`` return propagates to ``healthcheck`` as ``available=False``
    instead of crashing the process at import time.
    """
    try:
        return importlib.import_module(module)
    except ImportError:
        return None


def measure_latency(probe: Callable[[], None]) -> tuple[bool, int | None, str | None]:
    """Run ``probe`` and time it.

    Returns:
        ``(available, latency_ms, error_message)``. The probe must
        either return ``None`` (success) or raise. We never let an
        exception escape — health checks must be safe to call from a
        chain that wants to skip dead sources.
    """
    start = time.monotonic()
    try:
        probe()
    except Exception as exc:  # noqa: BLE001 — probe boundary
        return False, None, _short_repr(exc)
    elapsed_ms = int((time.monotonic() - start) * 1000)
    return True, elapsed_ms, None


def health_unavailable(name: str, reason: str) -> SourceHealth:
    return SourceHealth(
        name=name,
        available=False,
        latency_ms=None,
        quota_remaining=None,
        last_error=reason,
    )


def health_ok(name: str, latency_ms: int | None = None) -> SourceHealth:
    return SourceHealth(
        name=name,
        available=True,
        latency_ms=latency_ms,
        quota_remaining=None,
        last_error=None,
    )


def utc_now_isoformat(now: datetime) -> str:
    """Format a UTC datetime as ISO-8601 with explicit offset."""
    return now.isoformat()


def wrap_source_error(name: str, exc: BaseException) -> QuantError:
    """Translate an SDK exception into a QuantError the chain can handle."""
    return QuantError(
        "SOURCE_UNAVAILABLE",
        f"{name}: {_short_repr(exc)}",
        {"source": name, "exc_type": type(exc).__name__},
    )


def _short_repr(exc: BaseException) -> str:
    msg = str(exc)
    if len(msg) > 200:
        return msg[:197] + "..."
    return msg or type(exc).__name__
