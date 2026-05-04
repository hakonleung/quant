"""``WatchQuoteSource`` and ``UniverseSource`` ports for module W-0."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from collections.abc import Iterable

    from quant_core.domain.types.watch import SpotQuote, StockBasic, WatchMarket


@runtime_checkable
class WatchQuoteSource(Protocol):
    """Single-code realtime quote backend (akshare in production)."""

    def fetch_one(self, market: WatchMarket, code: str) -> SpotQuote:
        """Fetch one realtime quote.

        Raises:
            QuantError: ``WATCH_QUOTE_UPSTREAM_FAIL`` when the upstream
                call fails or returns malformed data.
        """
        ...


@runtime_checkable
class UniverseSource(Protocol):
    """Full HK / US universe snapshot — used by the universe refresh op."""

    def fetch_universe(self, market: WatchMarket) -> Iterable[StockBasic]:
        """Yield ``StockBasic`` rows for the requested market.

        Raises:
            QuantError: ``SOURCE_UNAVAILABLE`` on connectivity failure.
        """
        ...
