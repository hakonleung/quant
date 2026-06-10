"""Flight op for the A-share trading calendar (modules/09 §3.1).

* ``get_latest_trade_day`` — no args; returns a 1-row Arrow table with a
  single ``trade_date`` column carrying the latest trading day whose
  bar is *expected to be available* right now in Beijing time.

The "expected to be available" qualifier is what stops the cron
orchestrator from re-syncing every code on weekends, holidays, or
mid-session: codes whose persisted ``last_date`` already equals the
op's answer are caught up and skip the queue entirely.

Timing rule:
  - If now-Beijing is a calendar trading day **and** clock ≥ 16:30,
    probe akshare's daily endpoint.
  - If the sentinel daily bars have printed today, return today.
  - Otherwise return the previous trading day.

The akshare lookup is cached in-memory keyed by the calendar day, so
the cron's hourly scan does not refetch the calendar 24 times a day.
"""

from __future__ import annotations

import threading
from datetime import date as date_cls
from datetime import datetime, time, timedelta, timezone
from typing import TYPE_CHECKING, Any, Final

import pyarrow as pa
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping


_OP: Final[str] = "get_latest_trade_day"
_SCHEMA: Final[pa.Schema] = pa.schema([("trade_date", pa.date32())])
_BEIJING_TZ: Final[timezone] = timezone(timedelta(hours=8))
_MARKET_CLOSE: Final[time] = time(16, 30)
_SENTINEL_SYMBOLS: Final[tuple[str, ...]] = ("sh600519", "sz000001")


class GetLatestTradeDayHandler:
    """``get_latest_trade_day`` — A-share trading-day freshness threshold."""

    op = _OP
    schema = _SCHEMA

    __slots__ = ("_calendar_cache", "_calendar_lock", "_clock", "_result_cache")

    def __init__(self, clock: Any) -> None:
        self._clock = clock
        # Calendar fetch — full list of trading days (rare cache miss).
        self._calendar_cache: tuple[date_cls, list[date_cls]] | None = None
        # Per-calendar-day-and-bucket cache for the resolved threshold.
        # Key is ``(today_beijing, after_close_bucket)`` so the answer
        # flips at 16:30 even if `today` doesn't change.
        self._result_cache: tuple[tuple[date_cls, bool], date_cls] | None = None
        self._calendar_lock = threading.Lock()

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        del args
        beijing = self._clock.now().astimezone(_BEIJING_TZ)
        today = beijing.date()
        after_close = beijing.time() >= _MARKET_CLOSE
        bucket_key = (today, after_close)

        if self._result_cache is not None and self._result_cache[0] == bucket_key:
            latest = self._result_cache[1]
            return pa.Table.from_pylist([{"trade_date": latest}], schema=_SCHEMA)

        trade_days = self._fetch_calendar(today)
        if not trade_days:
            raise QuantError(
                "KLINE_DATA_MISSING",
                "akshare trade calendar returned no rows",
            )

        if after_close and today in trade_days and self._source_has_today_bar(today):
            latest = today
        else:
            before_today = [d for d in trade_days if d < today]
            if not before_today:
                raise QuantError(
                    "KLINE_DATA_MISSING",
                    f"no trading day strictly before {today}",
                )
            latest = max(before_today)

        if latest == today or not after_close:
            self._result_cache = (bucket_key, latest)
        return pa.Table.from_pylist([{"trade_date": latest}], schema=_SCHEMA)

    def _fetch_calendar(self, today: date_cls) -> list[date_cls]:
        with self._calendar_lock:
            if self._calendar_cache is not None and self._calendar_cache[0] == today:
                return self._calendar_cache[1]
            import akshare as ak

            try:
                df = ak.tool_trade_date_hist_sina()
            except Exception as exc:
                raise QuantError(
                    "SOURCE_UNAVAILABLE",
                    f"akshare tool_trade_date_hist_sina failed: {exc}",
                ) from exc
            trade_days: list[date_cls] = []
            for raw in df["trade_date"]:
                trade_days.append(_to_date(raw))
            trade_days.sort()
            self._calendar_cache = (today, trade_days)
            return trade_days

    def _source_has_today_bar(self, today: date_cls) -> bool:
        import akshare as ak

        for symbol in _SENTINEL_SYMBOLS:
            try:
                raw = ak.stock_zh_a_daily(
                    symbol=symbol,
                    start_date=_yyyymmdd(today),
                    end_date=_yyyymmdd(today),
                    adjust="",
                )
            except Exception as exc:
                raise QuantError(
                    "SOURCE_UNAVAILABLE",
                    f"akshare stock_zh_a_daily({symbol}) failed: {exc}",
                ) from exc
            if _last_daily_date(raw) != today:
                return False
        return True


def _to_date(raw: Any) -> date_cls:
    if isinstance(raw, date_cls) and not isinstance(raw, datetime):
        return raw
    if isinstance(raw, datetime):
        return raw.date()
    text = str(raw)
    return datetime.strptime(text[:10], "%Y-%m-%d").date()


def _yyyymmdd(day: date_cls) -> str:
    return day.strftime("%Y%m%d")


def _last_daily_date(raw: object) -> date_cls | None:
    try:
        dates = raw["date"]  # type: ignore[index]  # pandas-like or test double
    except (KeyError, TypeError):
        return None
    if len(dates) == 0:
        return None
    iloc = getattr(dates, "iloc", None)
    if iloc is not None:
        return _to_date(iloc[-1])
    return _to_date(dates[-1])
