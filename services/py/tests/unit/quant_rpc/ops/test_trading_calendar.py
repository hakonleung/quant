"""Unit tests for ``GetLatestTradeDayHandler`` (modules/09 §3.1).

Pins the timing rule that gates the cron from re-syncing every code on
holidays / mid-session: today only after 16:30 Beijing on a trading
day; otherwise the previous trading day. The akshare lookup is stubbed
so the test runs offline and deterministically.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from quant_core.errors import QuantError
from quant_rpc.ops.trading_calendar import GetLatestTradeDayHandler

_TRADE_DAYS = [
    date(2026, 4, 27),  # Mon
    date(2026, 4, 28),  # Tue
    date(2026, 4, 29),  # Wed
    date(2026, 4, 30),  # Thu  ← last trade day before Labor Day
    # 2026-05-01 .. 2026-05-03 — Labor Day, market closed
    date(2026, 5, 4),  # Mon
    date(2026, 5, 5),  # Tue
]


class _FixedClock:
    """Returns the same UTC-aware datetime on every call."""

    __slots__ = ("_now",)

    def __init__(self, beijing_dt: datetime) -> None:
        # Beijing → UTC for the clock contract.
        utc = beijing_dt.replace(tzinfo=timezone(timedelta(hours=8))).astimezone(UTC)
        self._now = utc

    def now(self) -> datetime:
        return self._now


def _resolve(beijing_dt: datetime, *, source_ready: bool = True) -> date:
    """Drive the handler with a stub calendar and return the resolved date."""
    handler = GetLatestTradeDayHandler(_FixedClock(beijing_dt))

    class _StubDF:
        def __init__(self, rows: list[date]) -> None:
            self._rows = rows

        def __getitem__(self, key: str) -> list[date]:
            assert key in {"date", "trade_date"}
            return self._rows

    class _StubAk:
        @staticmethod
        def tool_trade_date_hist_sina() -> _StubDF:
            return _StubDF(list(_TRADE_DAYS))

        @staticmethod
        def stock_zh_a_daily(
            symbol: str,
            start_date: str,
            end_date: str,
            adjust: str,
        ) -> _StubDF:
            del symbol, end_date, adjust
            day = date.fromisoformat(f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:8]}")
            rows = [day] if source_ready else [date(2026, 4, 30)]
            return _StubDF(rows)

    with patch.dict("sys.modules", {"akshare": _StubAk}):
        table = handler.execute({})
    return table.column("trade_date")[0].as_py()


# --------------------------------------------------------------------------- #
# pre-close: today's bar isn't expected yet → previous trade day              #
# --------------------------------------------------------------------------- #


def test_before_market_open_on_a_trading_day_returns_previous() -> None:
    # Monday 2026-05-04 09:00 Beijing — before the 09:30 open and well
    # before the 16:30 freshness gate; today's bar can't exist yet.
    got = _resolve(datetime(2026, 5, 4, 9, 0))
    assert got == date(2026, 4, 30)


def test_during_session_on_a_trading_day_returns_previous() -> None:
    # Monday 2026-05-04 12:00 Beijing — mid-session; bar still open.
    got = _resolve(datetime(2026, 5, 4, 12, 0))
    assert got == date(2026, 4, 30)


def test_16_29_still_returns_previous_trade_day() -> None:
    # One minute before the freshness gate.
    got = _resolve(datetime(2026, 5, 4, 16, 29))
    assert got == date(2026, 4, 30)


# --------------------------------------------------------------------------- #
# post-close: today's bar is expected → today                                 #
# --------------------------------------------------------------------------- #


def test_at_freshness_gate_returns_today() -> None:
    # 16:30 sharp on a trading day — today's bar is accepted only after
    # akshare's daily endpoint confirms the sentinel bars printed today.
    got = _resolve(datetime(2026, 5, 4, 16, 30))
    assert got == date(2026, 5, 4)


def test_after_freshness_gate_returns_previous_when_source_lags() -> None:
    got = _resolve(datetime(2026, 5, 4, 16, 45), source_ready=False)
    assert got == date(2026, 4, 30)


def test_after_close_returns_today() -> None:
    got = _resolve(datetime(2026, 5, 4, 18, 30))
    assert got == date(2026, 5, 4)


# --------------------------------------------------------------------------- #
# weekends + holidays: never today, regardless of clock                       #
# --------------------------------------------------------------------------- #


def test_saturday_after_close_still_returns_friday() -> None:
    # Sat 2026-05-02 22:00 Beijing — Labor Day weekend, no session today.
    got = _resolve(datetime(2026, 5, 2, 22, 0))
    assert got == date(2026, 4, 30)


def test_sunday_morning_returns_last_friday() -> None:
    got = _resolve(datetime(2026, 5, 3, 8, 0))
    assert got == date(2026, 4, 30)


def test_holiday_friday_returns_previous_thursday() -> None:
    # Labor Day Friday — 2026-05-01 is a holiday on the stub calendar,
    # so even at 18:00 the answer is the prior Thursday.
    got = _resolve(datetime(2026, 5, 1, 18, 0))
    assert got == date(2026, 4, 30)


# --------------------------------------------------------------------------- #
# bucket cache: 16:30 boundary actually flips                                 #
# --------------------------------------------------------------------------- #


def test_cache_flips_across_close_boundary() -> None:
    # Same handler instance, two queries at 16:29 and 16:31 — both
    # within the same calendar day. The result-cache key includes the
    # after-close bucket so the answer must update.
    handler = GetLatestTradeDayHandler(_FixedClock(datetime(2026, 5, 4, 16, 29)))

    class _StubDF:
        def __init__(self, rows: list[date]) -> None:
            self._rows = rows

        def __getitem__(self, key: str) -> list[date]:
            assert key in {"date", "trade_date"}
            return self._rows

    class _StubAk:
        @staticmethod
        def tool_trade_date_hist_sina() -> _StubDF:
            return _StubDF(list(_TRADE_DAYS))

        @staticmethod
        def stock_zh_a_daily(
            symbol: str,
            start_date: str,
            end_date: str,
            adjust: str,
        ) -> _StubDF:
            del symbol, end_date, adjust
            day = date.fromisoformat(f"{start_date[:4]}-{start_date[4:6]}-{start_date[6:8]}")
            return _StubDF([day])

    with patch.dict("sys.modules", {"akshare": _StubAk}):
        before = handler.execute({}).column("trade_date")[0].as_py()
        # Advance the wall clock past the close gate.
        handler._clock = _FixedClock(datetime(2026, 5, 4, 16, 31))  # type: ignore[attr-defined]
        after = handler.execute({}).column("trade_date")[0].as_py()

    assert before == date(2026, 4, 30)
    assert after == date(2026, 5, 4)


# --------------------------------------------------------------------------- #
# upstream failures                                                           #
# --------------------------------------------------------------------------- #


def test_empty_calendar_raises_data_missing() -> None:
    handler = GetLatestTradeDayHandler(_FixedClock(datetime(2026, 5, 4, 12, 0)))

    class _StubDF:
        def __getitem__(self, key: str) -> list[date]:
            assert key == "trade_date"
            return []

    class _StubAk:
        @staticmethod
        def tool_trade_date_hist_sina() -> _StubDF:
            return _StubDF()

    with patch.dict("sys.modules", {"akshare": _StubAk}), pytest.raises(QuantError) as exc:
        handler.execute({})
    assert exc.value.code == "KLINE_DATA_MISSING"


def test_akshare_failure_surfaces_as_source_unavailable() -> None:
    handler = GetLatestTradeDayHandler(_FixedClock(datetime(2026, 5, 4, 12, 0)))

    class _StubAk:
        @staticmethod
        def tool_trade_date_hist_sina() -> None:
            raise RuntimeError("network down")

    with patch.dict("sys.modules", {"akshare": _StubAk}), pytest.raises(QuantError) as exc:
        handler.execute({})
    assert exc.value.code == "SOURCE_UNAVAILABLE"
