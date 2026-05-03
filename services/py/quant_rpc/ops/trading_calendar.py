"""Flight op for the A-share trading calendar (modules/09 §3.1).

* ``get_latest_trade_day`` — no args; returns a 1-row Arrow table with a
  single ``trade_date`` column carrying the latest trading day whose
  bar is *expected to be available* right now in Beijing time.

The "expected to be available" qualifier is what stops the cron
orchestrator from re-syncing every code on weekends, holidays, or
mid-session: codes whose persisted ``last_date`` already equals the
op's answer are caught up and skip the queue entirely.

Timing rule:
  - If now-Beijing is a calendar trading day **and** clock ≥ 16:00,
    today's bar should exist → return today.
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
_MARKET_CLOSE: Final[time] = time(16, 0)


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
        # flips at 16:00 even if `today` doesn't change.
        self._result_cache: tuple[tuple[date_cls, bool], date_cls] | None = None
        self._calendar_lock = threading.Lock()

    def execute(self, args: "Mapping[str, object]") -> pa.Table:
        del args
        beijing = self._clock.now().astimezone(_BEIJING_TZ)
        today = beijing.date()
        after_close = beijing.time() >= _MARKET_CLOSE
        bucket_key = (today, after_close)

        if self._result_cache is not None and self._result_cache[0] == bucket_key:
            latest = self._result_cache[1]
            return pa.Table.from_pylist(
                [{"trade_date": latest}], schema=_SCHEMA
            )

        trade_days = self._fetch_calendar(today)
        if not trade_days:
            raise QuantError(
                "DATA_MISSING",
                "akshare trade calendar returned no rows",
            )

        if after_close and today in trade_days:
            latest = today
        else:
            before_today = [d for d in trade_days if d < today]
            if not before_today:
                raise QuantError(
                    "DATA_MISSING",
                    f"no trading day strictly before {today}",
                )
            latest = max(before_today)

        self._result_cache = (bucket_key, latest)
        return pa.Table.from_pylist([{"trade_date": latest}], schema=_SCHEMA)

    def _fetch_calendar(self, today: date_cls) -> list[date_cls]:
        with self._calendar_lock:
            if self._calendar_cache is not None and self._calendar_cache[0] == today:
                return self._calendar_cache[1]
            import akshare as ak  # noqa: PLC0415 — heavy import deferred
            try:
                df = ak.tool_trade_date_hist_sina()
            except Exception as exc:  # noqa: BLE001 — adapter boundary
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


def _to_date(raw: Any) -> date_cls:
    if isinstance(raw, date_cls) and not isinstance(raw, datetime):
        return raw
    if isinstance(raw, datetime):
        return raw.date()
    text = str(raw)
    return datetime.strptime(text[:10], "%Y-%m-%d").date()
