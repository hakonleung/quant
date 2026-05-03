"""``KlineSource`` port — source adapter contract for daily K-line data.

Adapters live in ``quant_io.sources``; the default is AKShare. Sources
return raw (un-adjusted) bars + a separate stream of adjustment factors.
The qfq computation runs in :mod:`quant_core.domain.rules.qfq`, not in
the source — keeping adapters thin and substitutable.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from collections.abc import Iterable
    from datetime import date

    from quant_core.domain.types.kline import AdjFactor, RawDailyBar
    from quant_core.domain.types.source import SourceHealth


@runtime_checkable
class KlineSource(Protocol):
    """A backend that can fetch daily bars + adj_factors for one stock."""

    @property
    def name(self) -> str:
        """Stable identifier (e.g. ``"akshare"``). Used in logs + state."""
        ...

    def healthcheck(self) -> SourceHealth:
        """Cheap reachability probe. Must not raise."""
        ...

    def fetch_range(self, code: str, start: date, end: date) -> Iterable[RawDailyBar]:
        """Yield raw bars in [start, end] (inclusive), ascending by date.

        Empty result is valid (e.g. a stock listed after ``end``).

        Raises:
            QuantError: ``SOURCE_UNAVAILABLE`` on connectivity / SDK failure.
        """
        ...

    def fetch_adj_factors(self, code: str, start: date, end: date) -> Iterable[AdjFactor]:
        """Yield adj_factors in [start, end] (inclusive), ascending by date.

        Sources that publish a single "current" factor for the whole
        history are still required to expose at least one entry inside
        the requested window so :func:`compute_qfq_prices` has a baseline.

        Raises:
            QuantError: ``SOURCE_UNAVAILABLE`` on connectivity / SDK failure.
        """
        ...
