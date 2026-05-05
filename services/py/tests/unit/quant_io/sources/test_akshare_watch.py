"""Unit tests for ``AKShareWatchSource._fetch_us`` window construction.

Regression coverage for the bug where UTC timestamps were passed to
``stock_us_hist_min_em``. The endpoint filters server-side using
ET wall-clock; passing UTC strings shifts the requested window 4-5h
forward in ET and lands fully in the future during the first half of
a US session, returning an empty frame.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from quant_core.errors import QuantError
from quant_io.sources import akshare_watch as mod
from quant_io.sources.akshare_watch import AKShareWatchSource

_ET = ZoneInfo("America/New_York")
_FMT = "%Y-%m-%d %H:%M:%S"


class _FakeGateway:
    """Records the (start, end) the source passed to ``stock_us_hist_min_em``."""

    def __init__(
        self,
        *,
        minute_records: list[dict[str, object]] | None = None,
        daily_records: list[dict[str, object]] | None = None,
    ) -> None:
        self.minute_calls: list[tuple[str, str, str]] = []
        self._minute_records = minute_records if minute_records is not None else []
        self._daily_records = daily_records if daily_records is not None else [{"close": "100"}]

    def stock_us_hist_min_em(
        self, symbol: str, start_date: str, end_date: str
    ) -> list[dict[str, object]]:
        self.minute_calls.append((symbol, start_date, end_date))
        return list(self._minute_records)

    def stock_us_daily(self, symbol: str) -> list[dict[str, object]]:
        return [dict(r) for r in self._daily_records]

    # Unused — present so the duck-typed Protocol check passes.
    def stock_bid_ask_em(self, symbol: str) -> object:
        raise AssertionError("not used")

    def stock_hk_hist_min_em(self, symbol: str, period: str) -> object:
        raise AssertionError("not used")

    def stock_hk_daily(self, symbol: str) -> object:
        raise AssertionError("not used")

    def stock_hk_spot_em(self) -> object:
        raise AssertionError("not used")

    def stock_us_spot_em(self) -> object:
        raise AssertionError("not used")


class _FrozenDatetime(datetime):
    """``datetime`` subclass whose ``now(tz)`` returns a fixed instant."""

    _frozen: datetime

    @classmethod
    def now(cls, tz: ZoneInfo | None = None) -> datetime:  # type: ignore[override]
        if tz is None:
            return cls._frozen.replace(tzinfo=None)
        return cls._frozen.astimezone(tz)


def _freeze(monkeypatch: pytest.MonkeyPatch, instant: datetime) -> None:
    """Patch ``datetime`` inside the source module so ``datetime.now`` is fixed."""
    cls = type("FrozenDT", (_FrozenDatetime,), {"_frozen": instant})
    monkeypatch.setattr(mod, "datetime", cls)


def _make_source(gw: _FakeGateway) -> AKShareWatchSource:
    src = AKShareWatchSource.__new__(AKShareWatchSource)
    # Bypass ``__init__`` (which lazy-imports akshare); seed slots directly.
    src._ak = gw
    src._prev_close_cache = {}
    return src


def _minute_row(close: str, high: str, low: str) -> dict[str, object]:
    return {"收盘": close, "最高": high, "最低": low}


class TestFetchUsWindow:
    def test_window_uses_et_wall_clock_during_dst(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # 2026-05-05 14:12 UTC == 10:12 ET (EDT, UTC-4).
        instant = datetime(2026, 5, 5, 14, 12, 0, tzinfo=UTC)
        _freeze(monkeypatch, instant)
        gw = _FakeGateway(minute_records=[_minute_row("12.34", "12.50", "12.00")])
        src = _make_source(gw)

        src.fetch_one("us", "105.SNDK")

        assert len(gw.minute_calls) == 1
        symbol, start_s, end_s = gw.minute_calls[0]
        assert symbol == "105.SNDK"
        # ET wall-clock 10:12 (and 90 minutes earlier 08:42). NOT 14:12.
        assert end_s == "2026-05-05 10:12:00"
        assert start_s == "2026-05-05 08:42:00"

    def test_window_uses_et_wall_clock_outside_dst(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # 2026-01-15 19:30 UTC == 14:30 ET (EST, UTC-5).
        instant = datetime(2026, 1, 15, 19, 30, 0, tzinfo=UTC)
        _freeze(monkeypatch, instant)
        gw = _FakeGateway(minute_records=[_minute_row("50", "51", "49")])
        src = _make_source(gw)

        src.fetch_one("us", "AAPL")

        _, start_s, end_s = gw.minute_calls[0]
        assert end_s == "2026-01-15 14:30:00"
        assert start_s == "2026-01-15 13:00:00"

    def test_window_handles_dst_spring_forward(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # 2026-03-08 02:00 ET DST transition (skip to 03:00 ET).
        # Pick a UTC instant ~30 min after the jump: 07:30 UTC == 03:30 ET (EDT).
        instant = datetime(2026, 3, 8, 7, 30, 0, tzinfo=UTC)
        _freeze(monkeypatch, instant)
        gw = _FakeGateway(minute_records=[_minute_row("1", "1", "1")])
        src = _make_source(gw)

        src.fetch_one("us", "TSLA")

        _, start_s, end_s = gw.minute_calls[0]
        assert end_s == "2026-03-08 03:30:00"
        # 90 min earlier in wall-clock: 02:00 ET — but that hour was skipped,
        # so zoneinfo lands at 01:00 EST or 03:00 EDT depending on fold.
        # Compute the expected value directly from zoneinfo to stay honest.
        expected_start = (instant.astimezone(_ET) - timedelta(minutes=90)).strftime(_FMT)
        assert start_s == expected_start

    def test_empty_minute_frame_still_raises_quant_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        instant = datetime(2026, 5, 5, 20, 0, 0, tzinfo=UTC)
        _freeze(monkeypatch, instant)
        gw = _FakeGateway(minute_records=[])
        src = _make_source(gw)

        with pytest.raises(QuantError) as ei:
            src.fetch_one("us", "DEAD")

        assert ei.value.code == "WATCH_QUOTE_UPSTREAM_FAIL"
        assert "empty minute frame for us:DEAD" in str(ei.value)

    def test_returns_spot_quote_with_session_summary(self, monkeypatch: pytest.MonkeyPatch) -> None:
        instant = datetime(2026, 5, 5, 20, 0, 0, tzinfo=UTC)
        _freeze(monkeypatch, instant)
        gw = _FakeGateway(
            minute_records=[
                _minute_row("100.0", "101.5", "99.0"),
                _minute_row("102.0", "103.0", "101.0"),
            ],
            daily_records=[{"close": "98.5"}],
        )
        src = _make_source(gw)

        quote = src.fetch_one("us", "AAPL")

        assert quote.market == "us"
        assert quote.code == "AAPL"
        assert quote.last == Decimal("102.0")
        assert quote.day_high == Decimal("103.0")
        assert quote.day_low == Decimal("99.0")
        assert quote.prev_close == Decimal("98.5")
