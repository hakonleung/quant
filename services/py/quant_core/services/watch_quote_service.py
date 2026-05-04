"""Watch (W-0) realtime quote service.

Thin orchestration around a :class:`WatchQuoteSource` — currently a
1:1 passthrough, but exists as a service so the Flight handler stays
decoupled from the source SDK.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from quant_core.domain.types.watch import SpotQuote, StockBasic, WatchMarket
    from quant_core.ports.watch_quote_source import UniverseSource, WatchQuoteSource


class WatchQuoteService:
    """Resolve a single realtime quote (or a universe refresh)."""

    __slots__ = ("_quotes", "_universe")

    def __init__(self, quotes: WatchQuoteSource, universe: UniverseSource) -> None:
        self._quotes = quotes
        self._universe = universe

    def fetch_one(self, market: WatchMarket, code: str) -> SpotQuote:
        return self._quotes.fetch_one(market, code)

    def refresh_universe(self, market: WatchMarket) -> list[StockBasic]:
        return list(self._universe.fetch_universe(market))
