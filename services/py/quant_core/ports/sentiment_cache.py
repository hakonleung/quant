"""Sentiment cache port (modules/06-sentiment-analysis.md §5.2).

Two narrow methods per result kind ``get`` / ``put`` plus an explicit
``invalidate_stock`` for the "force refresh" UI affordance. The expiry
policy (``asof + 2 days``) is handled inside the adapter — callers do not
pass a TTL because there is only one allowed policy.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import date

    from quant_core.domain.types.sentiment import MarketSentiment, StockSentiment


@runtime_checkable
class SentimentCache(Protocol):
    """Per-result cache for ``StockSentiment`` and ``MarketSentiment``.

    Adapters MUST treat any payload whose ``schema_version`` differs from
    :data:`quant_core.domain.types.sentiment.SCHEMA_VERSION` as a miss.
    Adapters MUST treat any payload whose effective expiry
    (``datetime(asof + 2 days, 00:00, UTC)``) is in the past as a miss.
    """

    def get_stock(self, code: str, asof: date, window_days: int) -> StockSentiment | None:
        """Return a fresh cached single-stock payload, or ``None`` on miss."""
        ...

    def put_stock(self, value: StockSentiment) -> None:
        """Write a single-stock payload. Idempotent (overwrites)."""
        ...

    def get_market(
        self, codes: Sequence[str], asof: date, window_days: int
    ) -> MarketSentiment | None:
        """Return a fresh cached aggregate payload, or ``None`` on miss.

        Implementations MUST canonicalise ``codes`` (sort + dedup) before
        hashing so that ``["600519", "000001"]`` and ``["000001", "600519"]``
        share a key.
        """
        ...

    def put_market(self, value: MarketSentiment) -> None:
        """Write an aggregate payload. Idempotent."""
        ...

    def invalidate_stock(self, code: str) -> None:
        """Remove every cached single-stock payload for ``code``.

        Used by the "force refresh" button in the UI. Must walk all
        ``asof`` directories — calls cross days when a user revisits a
        stock after a corporate event."""
        ...
