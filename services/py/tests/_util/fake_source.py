"""Reusable fake :class:`StockMetaSource` for service-level tests."""

from __future__ import annotations

from typing import TYPE_CHECKING

from quant_core.domain.types.source import SourceHealth

if TYPE_CHECKING:
    from collections.abc import Iterable

    from quant_core.domain.types.stock import StockMeta
    from quant_core.errors import QuantError


class FakeStockMetaSource:
    """Configurable fake.

    Args:
        name: Source identifier reported via the protocol.
        priority: Lower means higher precedence in the chain.
        items: Records returned by ``fetch_all``.
        available: Reported by ``healthcheck``.
        fetch_error: If non-``None``, ``fetch_all`` raises this instead.
    """

    def __init__(
        self,
        *,
        name: str = "fake",
        priority: int = 1,
        items: Iterable[StockMeta] = (),
        available: bool = True,
        fetch_error: QuantError | None = None,
    ) -> None:
        self._name = name
        self._priority = priority
        self._items = tuple(items)
        self._available = available
        self._fetch_error = fetch_error
        self.fetch_all_calls = 0

    @property
    def name(self) -> str:
        return self._name

    @property
    def priority(self) -> int:
        return self._priority

    def healthcheck(self) -> SourceHealth:
        return SourceHealth(
            name=self._name,
            available=self._available,
            latency_ms=1 if self._available else None,
            quota_remaining=None,
            last_error=None if self._available else "fake source disabled",
        )

    def fetch_all(self) -> Iterable[StockMeta]:
        self.fetch_all_calls += 1
        if self._fetch_error is not None:
            raise self._fetch_error
        return iter(self._items)

    def fetch_one(self, code: str) -> StockMeta | None:
        for item in self._items:
            if item.code == code:
                return item
        return None
