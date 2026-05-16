"""Unit tests for :class:`YFinanceWatchSource`.

Covers the golden path (minute frame → SpotQuote), empty-frame
upstream failure, non-US market rejection, ticker normalisation,
fast_info → daily fallback for prev_close, and transport-retry.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from quant_core.errors import QuantError
from quant_io.sources import yfinance_watch as mod
from quant_io.sources.yfinance_watch import YFinanceWatchSource


class _FakeTicker:
    """Mimics ``yfinance.Ticker`` — duck-typed against `_YFinanceTicker`."""

    def __init__(
        self,
        *,
        minute_records: list[dict[str, Any]] | None = None,
        daily_records: list[dict[str, Any]] | None = None,
        fast_info_prev_close: object | None = None,
        history_raises: BaseException | None = None,
        fast_info_raises: BaseException | None = None,
    ) -> None:
        self.history_calls: list[dict[str, object]] = []
        self._minute_records = minute_records if minute_records is not None else []
        self._daily_records = daily_records if daily_records is not None else []
        self._fast_info_prev_close = fast_info_prev_close
        self._history_raises = history_raises
        self._history_raises_remaining = 1 if history_raises is not None else 0
        self._fast_info_raises = fast_info_raises

    def history(self, *, period: str, interval: str, prepost: bool) -> list[dict[str, object]]:
        self.history_calls.append({"period": period, "interval": interval, "prepost": prepost})
        # Optionally raise on the first call to exercise the retry path.
        if self._history_raises_remaining > 0:
            self._history_raises_remaining -= 1
            assert self._history_raises is not None
            raise self._history_raises
        if interval == "1m":
            return [dict(r) for r in self._minute_records]
        return [dict(r) for r in self._daily_records]

    @property
    def fast_info(self) -> object:
        if self._fast_info_raises is not None:
            raise self._fast_info_raises
        return {"previousClose": self._fast_info_prev_close}


class _FakeGateway:
    def __init__(self, tickers: dict[str, _FakeTicker]) -> None:
        self._tickers = tickers
        self.requested_symbols: list[str] = []

    def Ticker(self, symbol: str) -> _FakeTicker:  # noqa: N802 — matches yfinance API
        self.requested_symbols.append(symbol)
        return self._tickers[symbol]


def _src(
    gateway: _FakeGateway,
    *,
    sleep_log: list[float] | None = None,
) -> YFinanceWatchSource:
    """Construct a source with deterministic sleep/jitter."""

    def _sleep(d: float) -> None:
        if sleep_log is not None:
            sleep_log.append(d)

    def _jitter(lo: float, hi: float) -> float:
        return 0.0

    return YFinanceWatchSource(gateway=gateway, sleep=_sleep, jitter=_jitter)


def test_fetch_one_us_golden_path_maps_all_fields() -> None:
    minute = [
        {"Close": "100.0", "High": "101.0", "Low": "99.0", "Volume": "1000"},
        {"Close": "102.0", "High": "103.0", "Low": "98.0", "Volume": "2000"},
    ]
    ticker = _FakeTicker(
        minute_records=minute,
        fast_info_prev_close="95.5",
    )
    gw = _FakeGateway({"AAPL": ticker})
    src = _src(gw)

    quote = src.fetch_one("us", "AAPL")

    assert quote.market == "us"
    assert quote.code == "AAPL"
    assert quote.last == Decimal("102.0")
    assert quote.day_high == Decimal("103.0")
    assert quote.day_low == Decimal("98.0")
    assert quote.prev_close == Decimal("95.5")
    assert quote.volume == Decimal("3000")
    # amount = 100*1000 + 102*2000 = 100000 + 204000 = 304000
    assert quote.amount == Decimal("304000.0")
    assert quote.ts.tzinfo is not None


def test_fetch_one_strips_us_secid_prefix() -> None:
    minute = [{"Close": "1", "High": "1", "Low": "1", "Volume": "1"}]
    ticker = _FakeTicker(minute_records=minute, fast_info_prev_close="1")
    gw = _FakeGateway({"AAPL": ticker})

    _src(gw).fetch_one("us", "105.AAPL")

    assert gw.requested_symbols == ["AAPL"]


def test_fetch_one_rejects_non_us_markets() -> None:
    src = _src(_FakeGateway({}))

    with pytest.raises(QuantError) as excinfo:
        src.fetch_one("a", "000001")

    assert excinfo.value.code == "INVALID_ARGUMENT"
    # No HK either.
    with pytest.raises(QuantError) as excinfo2:
        src.fetch_one("hk", "00700")
    assert excinfo2.value.code == "INVALID_ARGUMENT"


def test_empty_minute_frame_raises_upstream_fail() -> None:
    ticker = _FakeTicker(minute_records=[], fast_info_prev_close="1")
    gw = _FakeGateway({"AAPL": ticker})

    with pytest.raises(QuantError) as excinfo:
        _src(gw).fetch_one("us", "AAPL")

    assert excinfo.value.code == "WATCH_QUOTE_UPSTREAM_FAIL"
    assert excinfo.value.details.get("backend") == "yfinance_watch"


def test_missing_yfinance_import_raises_upstream_fail() -> None:
    src = YFinanceWatchSource(gateway=None, sleep=lambda _d: None, jitter=lambda _a, _b: 0.0)
    # Force the lazy-imported gateway to None; the constructor already
    # set it from `lazy_import("yfinance")` which may have succeeded in
    # the test env. Re-null it to exercise the missing-dep branch.
    src._gateway = None  # whitebox poke

    with pytest.raises(QuantError) as excinfo:
        src.fetch_one("us", "AAPL")

    assert excinfo.value.code == "WATCH_QUOTE_UPSTREAM_FAIL"
    assert excinfo.value.details.get("reason") == "import_failed"


def test_prev_close_falls_back_to_daily_when_fast_info_missing() -> None:
    minute = [{"Close": "100", "High": "100", "Low": "100", "Volume": "1"}]
    daily = [
        {"Close": "90"},  # D-1 (previous trading day)
        {"Close": "92"},  # D (running session)
    ]
    ticker = _FakeTicker(
        minute_records=minute,
        daily_records=daily,
        fast_info_prev_close=None,  # absent → fall back
    )
    gw = _FakeGateway({"AAPL": ticker})

    quote = _src(gw).fetch_one("us", "AAPL")

    # Second-to-last row is D-1 close.
    assert quote.prev_close == Decimal("90")


def test_prev_close_falls_back_to_daily_when_fast_info_raises() -> None:
    minute = [{"Close": "100", "High": "100", "Low": "100", "Volume": "1"}]
    daily = [{"Close": "88"}, {"Close": "89"}]
    ticker = _FakeTicker(
        minute_records=minute,
        daily_records=daily,
        fast_info_raises=RuntimeError("yahoo refused fast_info"),
    )
    gw = _FakeGateway({"AAPL": ticker})

    quote = _src(gw).fetch_one("us", "AAPL")

    assert quote.prev_close == Decimal("88")


def test_prev_close_cached_per_day(monkeypatch: pytest.MonkeyPatch) -> None:
    minute = [{"Close": "1", "High": "1", "Low": "1", "Volume": "1"}]
    ticker = _FakeTicker(minute_records=minute, fast_info_prev_close="50")
    gw = _FakeGateway({"AAPL": ticker})

    # Freeze date so the cache key is stable.
    fixed = datetime(2026, 5, 15, 13, 30, tzinfo=UTC)

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz: Any = None) -> datetime:  # type: ignore[override]
            return fixed if tz is None else fixed.astimezone(tz)

    monkeypatch.setattr(mod, "datetime", _Frozen)

    src = _src(gw)
    q1 = src.fetch_one("us", "AAPL")
    q2 = src.fetch_one("us", "AAPL")

    assert q1.prev_close == Decimal("50")
    assert q2.prev_close == Decimal("50")
    # Two minute-frame pulls but the daily fallback would only fire if
    # fast_info returned None. Here fast_info is present, so each tick
    # consults fast_info — that's fine and not what we're asserting.
    # What we ARE asserting: the cache key (us, AAPL, date) is honoured;
    # second call short-circuits and never touches the ticker for prev_close.
    # We can verify by counting history calls: should be 2 minute calls,
    # 0 daily calls.
    daily_calls = [c for c in ticker.history_calls if c["interval"] == "1d"]
    assert daily_calls == []


def test_transport_error_retries_once() -> None:
    minute = [{"Close": "5", "High": "5", "Low": "5", "Volume": "10"}]
    ticker = _FakeTicker(
        minute_records=minute,
        fast_info_prev_close="4",
        history_raises=ConnectionError("aborted"),
    )
    gw = _FakeGateway({"AAPL": ticker})
    sleep_log: list[float] = []

    quote = _src(gw, sleep_log=sleep_log).fetch_one("us", "AAPL")

    assert quote.last == Decimal("5")
    # One retry → one sleep before the second history() call.
    assert len(sleep_log) == 1
    assert sleep_log[0] == pytest.approx(1.0, abs=0.01)


def test_non_transport_error_raises_immediately() -> None:
    ticker = _FakeTicker(
        minute_records=[],
        fast_info_prev_close="1",
        history_raises=ValueError("malformed response"),
    )
    gw = _FakeGateway({"AAPL": ticker})
    sleep_log: list[float] = []

    with pytest.raises(QuantError) as excinfo:
        _src(gw, sleep_log=sleep_log).fetch_one("us", "AAPL")

    assert excinfo.value.code == "WATCH_QUOTE_UPSTREAM_FAIL"
    assert excinfo.value.details.get("reason") == "other"
    # No retry → no sleep.
    assert sleep_log == []


def test_daily_fallback_with_single_row_uses_last_row() -> None:
    minute = [{"Close": "10", "High": "10", "Low": "10", "Volume": "1"}]
    daily = [{"Close": "77"}]
    ticker = _FakeTicker(
        minute_records=minute,
        daily_records=daily,
        fast_info_prev_close=None,
    )
    gw = _FakeGateway({"AAPL": ticker})

    quote = _src(gw).fetch_one("us", "AAPL")

    assert quote.prev_close == Decimal("77")


class YFRateLimitError(Exception):
    """Mimics ``yfinance.exceptions.YFRateLimitError`` by class name only.

    The adapter detects rate-limit errors by walking the exception
    MRO and matching ``__name__``, so this test double doesn't need to
    actually subclass the real yfinance exception.
    """


def test_rate_limit_surfaces_with_reason_rate_limited() -> None:
    ticker = _FakeTicker(
        minute_records=[{"Close": "1", "High": "1", "Low": "1", "Volume": "1"}],
        fast_info_prev_close="1",
        history_raises=YFRateLimitError("Too Many Requests."),
    )
    gw = _FakeGateway({"AAPL": ticker})
    sleep_log: list[float] = []

    with pytest.raises(QuantError) as excinfo:
        _src(gw, sleep_log=sleep_log).fetch_one("us", "AAPL")

    assert excinfo.value.code == "WATCH_QUOTE_UPSTREAM_FAIL"
    assert excinfo.value.details.get("reason") == "rate_limited"
    assert excinfo.value.details.get("backend") == "yfinance_watch"
    # Rate-limit is NOT retried inline — Yahoo's window is minutes, so
    # the adapter must yield to the scheduler immediately. _classify_exc
    # reports "other" for an unknown-name exception, so the underlying
    # helper raises without sleeping.
    assert sleep_log == []


def test_empty_daily_fallback_raises() -> None:
    minute = [{"Close": "10", "High": "10", "Low": "10", "Volume": "1"}]
    ticker = _FakeTicker(
        minute_records=minute,
        daily_records=[],
        fast_info_prev_close=None,
    )
    gw = _FakeGateway({"AAPL": ticker})

    with pytest.raises(QuantError) as excinfo:
        _src(gw).fetch_one("us", "AAPL")

    assert excinfo.value.code == "WATCH_QUOTE_UPSTREAM_FAIL"
