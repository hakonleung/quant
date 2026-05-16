"""Market-based dispatch for :class:`WatchQuoteSource`.

Each market pins to one concrete adapter at composition time — keeps
``YFinanceWatchSource`` (US-only, dodges East Money IP blocks) and
``AKShareWatchSource`` (A/HK) independent so neither has to know about
the other. If we later want yfinance→akshare fallback, add a
``FallbackWatchSource`` decorator on top of this — the routing layer
itself stays single-purpose.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.domain.types.watch import SpotQuote, WatchMarket
    from quant_core.ports.watch_quote_source import WatchQuoteSource


class MarketRoutedWatchSource:
    """Dispatch ``fetch_one`` to a per-market backend.

    A missing market entry raises ``INVALID_ARGUMENT`` instead of
    silently falling back — the routing table is part of the composition
    contract and a typo there should fail loudly at the first tick, not
    quietly degrade.
    """

    __slots__ = ("_by_market",)

    def __init__(self, by_market: Mapping[WatchMarket, WatchQuoteSource]) -> None:
        self._by_market: Mapping[WatchMarket, WatchQuoteSource] = by_market

    def fetch_one(self, market: WatchMarket, code: str) -> SpotQuote:
        source = self._by_market.get(market)
        if source is None:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"market_routed_watch: no source configured for market {market!r}",
                {"market": market},
            )
        return source.fetch_one(market, code)
