"""AKShare-backed realtime quote + universe sources for module W-0.

Single-code endpoints only — full-market spot calls (e.g.
``stock_zh_a_spot_em``) are reserved for the universe refresh path.
Quote-time calls dispatch by ``market``:

* ``a``  → ``ak.stock_bid_ask_em(symbol=code)`` (level-1 with prev close)
* ``hk`` → ``ak.stock_hk_hist_min_em`` for last/H/L + ``stock_hk_daily``
           for prev_close
* ``us`` → ``ak.stock_us_hist_min_em`` + ``stock_us_daily``

Failures are normalised to :class:`QuantError` with code
``WATCH_QUOTE_UPSTREAM_FAIL`` so the NestJS scheduler can downgrade them
to a warn log without taking down the whole tick.
"""

from __future__ import annotations

import random
import time
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Final, Protocol, cast, runtime_checkable
from zoneinfo import ZoneInfo

from quant_core.domain.types.watch import SpotQuote, StockBasic, WatchMarket
from quant_core.errors import QuantError

from quant_io.sources._common import lazy_import
from quant_io.sources._watch_common import (
    _classify_exc as _classify_exc_common,
)
from quant_io.sources._watch_common import (
    _decimal_or_zero as _decimal_or_zero_common,
)
from quant_io.sources._watch_common import (
    _strip_us_prefix as _strip_us_prefix_common,
)
from quant_io.sources._watch_common import (
    _to_decimal as _to_decimal_common,
)
from quant_io.sources._watch_common import (
    _to_records as _to_records_common,
)
from quant_io.sources._watch_common import (
    call_with_transport_retry,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable


_NAME: Final[str] = "akshare_watch"
# stock_us_hist_min_em filters and returns timestamps in Beijing time
# (Asia/Shanghai) — not ET, despite quoting US tickers. The endpoint
# silently returns an empty frame when the (start_date, end_date)
# window doesn't overlap any BJT-stamped bar.
_BJT: Final[ZoneInfo] = ZoneInfo("Asia/Shanghai")
# US minute history window. We only need the most recent bar plus a buffer
# for early-tick delays; 10 min is plenty and minimises both the upstream
# payload size and the surface area for `Connection aborted` mid-stream.
_US_WINDOW_MINUTES: Final[int] = 10


# Re-exports kept for backward compat with existing tests that reach into
# ``akshare_watch._classify_exc`` / ``_strip_us_prefix`` etc.
_classify_exc = _classify_exc_common
_strip_us_prefix = _strip_us_prefix_common


def _to_records(raw: object, *, label: str) -> list[dict[str, object]]:
    return _to_records_common(raw, label=label, backend=_NAME)


def _to_decimal(v: object, *, label: str) -> Decimal:
    return _to_decimal_common(v, label=label, backend=_NAME)


def _decimal_or_zero(v: object, *, label: str) -> Decimal:
    return _decimal_or_zero_common(v)


@runtime_checkable
class _AkshareGateway(Protocol):
    """Minimal duck-typed view of the akshare endpoints we use.

    Returned ``object`` is normalised through :func:`_to_records` (which
    calls ``to_dict("records")`` via ``getattr``); we don't import pandas
    so callers stay test-friendly.
    """

    def stock_bid_ask_em(self, symbol: str) -> object: ...
    def stock_hk_hist_min_em(self, symbol: str, period: str) -> object: ...
    def stock_hk_daily(self, symbol: str) -> object: ...
    def stock_us_hist_min_em(self, symbol: str, start_date: str, end_date: str) -> object: ...
    def stock_us_daily(self, symbol: str) -> object: ...
    def stock_hk_spot_em(self) -> object: ...
    def stock_us_spot_em(self) -> object: ...


class AKShareWatchSource:
    """Implements both :class:`WatchQuoteSource` and :class:`UniverseSource`."""

    __slots__ = ("_ak", "_jitter", "_prev_close_cache", "_sleep")

    def __init__(
        self,
        *,
        sleep: Callable[[float], None] | None = None,
        jitter: Callable[[float, float], float] | None = None,
    ) -> None:
        self._ak: object = lazy_import("akshare")
        self._prev_close_cache: dict[tuple[str, str], tuple[date, Decimal]] = {}
        # Injected for testability — the shared retry helper sleeps
        # between attempts, and tests want to assert delays without
        # actually waiting.
        self._sleep: Callable[[float], None] = sleep if sleep is not None else time.sleep
        self._jitter: Callable[[float, float], float] = (
            jitter if jitter is not None else random.uniform
        )

    def _call_with_transport_retry(
        self,
        fn: Callable[[], object],
        *,
        market: str,
        code: str,
        label: str,
    ) -> object:
        return call_with_transport_retry(
            fn,
            market=market,
            code=code,
            label=label,
            backend=_NAME,
            sleep=self._sleep,
            jitter=self._jitter,
        )

    def _require_ak(self) -> _AkshareGateway:
        if self._ak is None:
            raise QuantError(
                "WATCH_QUOTE_UPSTREAM_FAIL",
                f"{_NAME}: akshare not installed",
                {"reason": "import_failed", "backend": _NAME},
            )
        return cast("_AkshareGateway", self._ak)

    def fetch_one(self, market: WatchMarket, code: str) -> SpotQuote:
        if market == "a":
            return self._fetch_a(code)
        if market == "hk":
            return self._fetch_hk(code)
        if market == "us":
            return self._fetch_us(code)
        raise QuantError(
            "INVALID_ARGUMENT",
            f"{_NAME}: unknown market {market!r}",
            {"market": market},
        )

    def _fetch_a(self, code: str) -> SpotQuote:
        ak = self._require_ak()
        raw = self._call_with_transport_retry(
            lambda: ak.stock_bid_ask_em(symbol=code),
            market="a",
            code=code,
            label="stock_bid_ask_em",
        )
        kv = _bid_ask_to_kv(raw)
        return SpotQuote(
            market="a",
            code=code,
            last=_to_decimal(kv.get("最新"), label="last"),
            day_high=_to_decimal(kv.get("最高"), label="day_high"),
            day_low=_to_decimal(kv.get("最低"), label="day_low"),
            prev_close=_to_decimal(kv.get("昨收"), label="prev_close"),
            # ``stock_bid_ask_em`` reports cumulative session amount /
            # volume under "成交额" / "成交量"; both can be 0 before the
            # opening auction completes. Default to 0 so the NestJS
            # evaluator's ``vwap`` baseline guards against div-by-zero.
            amount=_decimal_or_zero(kv.get("成交额"), label="amount"),
            volume=_decimal_or_zero(kv.get("成交量"), label="volume"),
            ts=datetime.now(UTC),
        )

    def _fetch_hk(self, code: str) -> SpotQuote:
        ak = self._require_ak()
        raw = self._call_with_transport_retry(
            lambda: ak.stock_hk_hist_min_em(symbol=code, period="1"),
            market="hk",
            code=code,
            label="stock_hk_hist_min_em",
        )
        last, hi, lo, amount, volume = _minute_session_summary(raw, label=f"hk:{code}")
        prev_close = self._cached_prev_close(
            ("hk", code),
            lambda: ak.stock_hk_daily(symbol=code),
        )
        return SpotQuote(
            market="hk",
            code=code,
            last=last,
            day_high=hi,
            day_low=lo,
            prev_close=prev_close,
            amount=amount,
            volume=volume,
            ts=datetime.now(UTC),
        )

    def _fetch_us(self, code: str) -> SpotQuote:
        ak = self._require_ak()
        # Unlike the HK variant, ``stock_us_hist_min_em`` does NOT accept a
        # ``period`` kwarg (TypeError if passed). It also returns ALL minute
        # bars of the requested window — without a bound, that's the entire
        # available history. We only need the most recent session-level
        # bar, so ``_US_WINDOW_MINUTES`` (10) is enough — and a narrower
        # window also cuts the payload size that was causing frequent
        # ``Connection aborted`` mid-stream.
        # The upstream endpoint filters and stamps bars in BJT
        # (Asia/Shanghai), NOT ET — despite quoting US tickers. Passing
        # any other clock yields an empty frame because the BJT-stamped
        # bars don't overlap the requested window.
        end_bjt = datetime.now(_BJT)
        start_bjt = end_bjt - timedelta(minutes=_US_WINDOW_MINUTES)
        fmt = "%Y-%m-%d %H:%M:%S"
        start_str = start_bjt.strftime(fmt)
        end_str = end_bjt.strftime(fmt)
        raw = self._call_with_transport_retry(
            lambda: ak.stock_us_hist_min_em(
                symbol=code,
                start_date=start_str,
                end_date=end_str,
            ),
            market="us",
            code=code,
            label="stock_us_hist_min_em",
        )
        last, hi, lo, amount, volume = _minute_session_summary(raw, label=f"us:{code}")
        # ``stock_us_daily`` rejects the secid prefix (``105.AAPL`` ->
        # IndexError) — it only accepts the bare ticker. The minute
        # endpoint above is the opposite, hence two different shapes.
        bare = _strip_us_prefix(code)
        prev_close = self._cached_prev_close(
            ("us", code),
            lambda: ak.stock_us_daily(symbol=bare),
        )
        return SpotQuote(
            market="us",
            code=code,
            last=last,
            day_high=hi,
            day_low=lo,
            prev_close=prev_close,
            amount=amount,
            volume=volume,
            ts=datetime.now(UTC),
        )

    def _cached_prev_close(
        self,
        key: tuple[str, str],
        fetch: _DailyFetch,
    ) -> Decimal:
        today = datetime.now(UTC).date()
        cached = self._prev_close_cache.get(key)
        if cached is not None and cached[0] == today:
            return cached[1]
        raw = self._call_with_transport_retry(
            fetch,
            market=key[0],
            code=key[1],
            label="prev_close_daily",
        )
        records = _to_records(raw, label=f"daily:{key[0]}:{key[1]}")
        if not records:
            raise QuantError(
                "WATCH_QUOTE_UPSTREAM_FAIL",
                f"{_NAME}: empty daily frame for {key}",
                {"market": key[0], "code": key[1], "backend": _NAME},
            )
        # `stock_{hk,us}_daily` returns completed sessions only — the running
        # intraday bar is not appended. So the last row is the previous
        # trading day's close. (Earlier code took records[-2] on the
        # assumption that today's row was present — that's wrong: it skipped
        # one day back, so prev_close drifted to D-2 close.)
        row = records[-1]
        prev_close = _to_decimal(row.get("close", row.get("收盘")), label="prev_close")
        self._prev_close_cache[key] = (today, prev_close)
        return prev_close

    def fetch_universe(self, market: WatchMarket) -> Iterable[StockBasic]:
        ak = self._require_ak()
        if market == "hk":
            raw = ak.stock_hk_spot_em()
        elif market == "us":
            raw = ak.stock_us_spot_em()
        else:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"{_NAME}: universe refresh only supports hk/us, got {market!r}",
                {"market": market},
            )
        records = _to_records(raw, label=f"universe:{market}")
        out: list[StockBasic] = []
        for row in records:
            code_raw = row.get("代码")
            name_raw = row.get("名称")
            if not isinstance(code_raw, str) or not isinstance(name_raw, str):
                continue
            code = code_raw.upper() if market == "us" else code_raw
            out.append(StockBasic(market=market, code=code, name=name_raw))
        return out


class _DailyFetch(Protocol):
    def __call__(self) -> object: ...


def _bid_ask_to_kv(raw: object) -> dict[str, object]:
    """Two-column key/value DataFrame → dict (akshare bid/ask shape)."""
    records = _to_records(raw, label="bid_ask")
    if not records:
        raise QuantError(
            "WATCH_QUOTE_UPSTREAM_FAIL",
            f"{_NAME}: empty bid/ask response",
            {"backend": _NAME},
        )
    # ``stock_bid_ask_em`` returns rows like {"item": "最新", "value": 12.34}.
    if all("item" in r and "value" in r for r in records):
        return {str(r["item"]): r["value"] for r in records}
    # Fallback: a single wide row keyed by Chinese column name.
    return records[0]


def _minute_session_summary(
    raw: object, *, label: str
) -> tuple[Decimal, Decimal, Decimal, Decimal, Decimal]:
    """Return ``(last, day_high, day_low, amount_total, volume_total)``.

    Volume / amount are summed across the minute bars in the frame —
    this is intraday, so the upstream returns one row per minute since
    session open and the cumulative session total is just the sum.
    """
    records = _to_records(raw, label=label)
    if not records:
        raise QuantError(
            "WATCH_QUOTE_UPSTREAM_FAIL",
            f"{_NAME}: empty minute frame for {label}",
            {"label": label, "backend": _NAME},
        )
    last_row = records[-1]
    last = _to_decimal(last_row.get("收盘", last_row.get("close")), label="last")
    highs = [r.get("最高", r.get("high")) for r in records]
    lows = [r.get("最低", r.get("low")) for r in records]
    decimals_high = [_to_decimal(v, label="day_high") for v in highs if v is not None]
    decimals_low = [_to_decimal(v, label="day_low") for v in lows if v is not None]
    if not decimals_high or not decimals_low:
        raise QuantError(
            "WATCH_QUOTE_UPSTREAM_FAIL",
            f"{_NAME}: missing high/low columns in {label}",
            {"label": label, "backend": _NAME},
        )
    amount_total = Decimal(0)
    for r in records:
        amount_total += _decimal_or_zero(
            r.get("成交额", r.get("amount", r.get("turnover"))),
            label="amount",
        )
    volume_total = Decimal(0)
    for r in records:
        volume_total += _decimal_or_zero(
            r.get("成交量", r.get("volume")),
            label="volume",
        )
    return last, max(decimals_high), min(decimals_low), amount_total, volume_total
