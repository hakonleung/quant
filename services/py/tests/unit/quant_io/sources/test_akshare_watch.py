"""Unit tests for ``AKShareWatchSource._fetch_us`` window construction.

Regression coverage for the bug where UTC (and later ET) timestamps
were passed to ``stock_us_hist_min_em``. The endpoint filters and
stamps bars in BJT (Asia/Shanghai); any other clock returns an empty
frame.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from quant_core.errors import QuantError
from quant_io.sources import akshare_watch as mod
from quant_io.sources.akshare_watch import AKShareWatchSource

_BJT = ZoneInfo("Asia/Shanghai")
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
    def test_window_uses_bjt_wall_clock(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # 2026-05-05 14:12 UTC == 22:12 BJT.
        instant = datetime(2026, 5, 5, 14, 12, 0, tzinfo=UTC)
        _freeze(monkeypatch, instant)
        gw = _FakeGateway(minute_records=[_minute_row("12.34", "12.50", "12.00")])
        src = _make_source(gw)

        src.fetch_one("us", "105.SNDK")

        assert len(gw.minute_calls) == 1
        symbol, start_s, end_s = gw.minute_calls[0]
        assert symbol == "105.SNDK"
        # BJT wall-clock 22:12 (and 90 minutes earlier 20:42).
        assert end_s == "2026-05-05 22:12:00"
        assert start_s == "2026-05-05 20:42:00"

    def test_window_crosses_bjt_midnight_boundary(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # 2026-05-05 16:31 UTC == 2026-05-06 00:31 BJT (= 12:31 ET, mid-session).
        # 90 min earlier in BJT is 2026-05-05 23:01 — different calendar day.
        instant = datetime(2026, 5, 5, 16, 31, 0, tzinfo=UTC)
        _freeze(monkeypatch, instant)
        gw = _FakeGateway(minute_records=[_minute_row("1", "1", "1")])
        src = _make_source(gw)

        src.fetch_one("us", "106.VRT")

        _, start_s, end_s = gw.minute_calls[0]
        assert end_s == "2026-05-06 00:31:00"
        assert start_s == "2026-05-05 23:01:00"

    def test_window_outside_us_dst(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # BJT is fixed UTC+8 year-round (no DST). 2026-01-15 19:30 UTC == 2026-01-16 03:30 BJT.
        instant = datetime(2026, 1, 15, 19, 30, 0, tzinfo=UTC)
        _freeze(monkeypatch, instant)
        gw = _FakeGateway(minute_records=[_minute_row("50", "51", "49")])
        src = _make_source(gw)

        src.fetch_one("us", "AAPL")

        _, start_s, end_s = gw.minute_calls[0]
        assert end_s == "2026-01-16 03:30:00"
        assert start_s == "2026-01-16 02:00:00"

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

    def test_returns_spot_quote_with_session_summary(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
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

    def test_prev_close_strips_secid_prefix_for_stock_us_daily(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """stock_us_daily rejects the prefix; the source must call it with the bare ticker."""
        instant = datetime(2026, 5, 5, 20, 0, 0, tzinfo=UTC)
        _freeze(monkeypatch, instant)

        captured: list[str] = []

        class _PrefixSensitiveGateway(_FakeGateway):
            def stock_us_daily(self, symbol: str) -> list[dict[str, object]]:
                captured.append(symbol)
                if "." in symbol and symbol.split(".", 1)[0].isdigit():
                    raise IndexError("list index out of range")
                return [{"close": "98.5"}]

        gw = _PrefixSensitiveGateway(
            minute_records=[_minute_row("100.0", "101.0", "99.0")],
        )
        src = _make_source(gw)

        quote = src.fetch_one("us", "105.SNDK")
        assert captured == ["SNDK"]
        assert quote.prev_close == Decimal("98.5")
