"""Unit tests for :class:`MarketRoutedWatchSource`."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest
from quant_core.domain.types.watch import SpotQuote, WatchMarket
from quant_core.errors import QuantError
from quant_io.sources.routed_watch import MarketRoutedWatchSource


class _StubSource:
    def __init__(self, name: str) -> None:
        self.name = name
        self.calls: list[tuple[str, str]] = []

    def fetch_one(self, market: WatchMarket, code: str) -> SpotQuote:
        self.calls.append((market, code))
        return SpotQuote(
            market=market,
            code=code,
            last=Decimal(1),
            day_high=Decimal(1),
            day_low=Decimal(1),
            prev_close=Decimal(1),
            amount=Decimal(0),
            volume=Decimal(0),
            ts=datetime.now(UTC),
        )


def test_dispatches_to_per_market_source() -> None:
    ak = _StubSource("ak")
    yf = _StubSource("yf")
    router = MarketRoutedWatchSource({"a": ak, "hk": ak, "us": yf})

    router.fetch_one("a", "000001")
    router.fetch_one("hk", "00700")
    router.fetch_one("us", "AAPL")

    assert ak.calls == [("a", "000001"), ("hk", "00700")]
    assert yf.calls == [("us", "AAPL")]


def test_unconfigured_market_raises_invalid_argument() -> None:
    ak = _StubSource("ak")
    router = MarketRoutedWatchSource({"a": ak})

    with pytest.raises(QuantError) as excinfo:
        router.fetch_one("us", "AAPL")

    assert excinfo.value.code == "INVALID_ARGUMENT"
    assert excinfo.value.details.get("market") == "us"
