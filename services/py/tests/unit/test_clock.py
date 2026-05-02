"""Unit tests for the Clock port adapters."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from quant_core.adapters.clock import SystemClock
from quant_core.ports.clock import Clock

from tests._util.clock import FrozenClock


@pytest.mark.unit
class TestSystemClock:
    def test_now_returns_utc_aware_datetime(self) -> None:
        now = SystemClock().now()
        assert now.tzinfo is UTC

    def test_satisfies_clock_protocol(self) -> None:
        assert isinstance(SystemClock(), Clock)


@pytest.mark.unit
class TestFrozenClock:
    def test_now_returns_starting_time(self) -> None:
        start = datetime(2026, 1, 1, tzinfo=UTC)
        assert FrozenClock(start).now() == start

    def test_rejects_naive_start(self) -> None:
        with pytest.raises(ValueError, match="tz-aware"):
            FrozenClock(datetime(2026, 1, 1))

    def test_advance_moves_forward(self) -> None:
        clock = FrozenClock(datetime(2026, 1, 1, tzinfo=UTC))
        clock.advance(seconds=90)
        assert clock.now() == datetime(2026, 1, 1, 0, 1, 30, tzinfo=UTC)

    def test_advance_negative_rewinds(self) -> None:
        clock = FrozenClock(datetime(2026, 1, 1, 0, 1, 0, tzinfo=UTC))
        clock.advance(seconds=-30)
        assert clock.now() == datetime(2026, 1, 1, 0, 0, 30, tzinfo=UTC)

    def test_satisfies_clock_protocol(self) -> None:
        assert isinstance(FrozenClock(datetime(2026, 1, 1, tzinfo=UTC)), Clock)
