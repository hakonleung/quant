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

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Final, Protocol, cast, runtime_checkable
from zoneinfo import ZoneInfo

from quant_core.domain.types.watch import SpotQuote, StockBasic, WatchMarket
from quant_core.errors import QuantError

from quant_io.sources._common import lazy_import

if TYPE_CHECKING:
    from collections.abc import Iterable


_NAME: Final[str] = "akshare_watch"
_ET: Final[ZoneInfo] = ZoneInfo("America/New_York")


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


def _to_records(raw: object, *, label: str) -> list[dict[str, object]]:
    """Normalise pandas-DataFrame / list-of-dict to a list of records."""
    to_dict = getattr(raw, "to_dict", None)
    if callable(to_dict):
        records = to_dict("records")
        if isinstance(records, list):
            return [cast("dict[str, object]", r) for r in records if isinstance(r, dict)]
    if isinstance(raw, list):
        return [cast("dict[str, object]", r) for r in raw if isinstance(r, dict)]
    raise QuantError(
        "WATCH_QUOTE_UPSTREAM_FAIL",
        f"{_NAME}: {label} returned unsupported container: {type(raw).__name__}",
        {"label": label},
    )


def _to_decimal(v: object, *, label: str) -> Decimal:
    """Coerce a Python/pandas scalar to ``Decimal`` or raise upstream-fail."""
    try:
        if v is None:
            raise ValueError("None")
        return Decimal(str(v))
    except (InvalidOperation, ValueError) as exc:
        raise QuantError(
            "WATCH_QUOTE_UPSTREAM_FAIL",
            f"{_NAME}: bad {label}: {v!r}",
            {"field": label},
        ) from exc


class AKShareWatchSource:
    """Implements both :class:`WatchQuoteSource` and :class:`UniverseSource`."""

    __slots__ = ("_ak", "_prev_close_cache")

    def __init__(self) -> None:
        self._ak: object = lazy_import("akshare")
        self._prev_close_cache: dict[tuple[str, str], tuple[date, Decimal]] = {}

    def _require_ak(self) -> _AkshareGateway:
        if self._ak is None:
            raise QuantError(
                "WATCH_QUOTE_UPSTREAM_FAIL",
                f"{_NAME}: akshare not installed",
                {"reason": "import_failed"},
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
        try:
            raw = ak.stock_bid_ask_em(symbol=code)
        except Exception as exc:
            raise QuantError(
                "WATCH_QUOTE_UPSTREAM_FAIL",
                f"{_NAME}: stock_bid_ask_em({code}) failed: {exc!r}",
                {"market": "a", "code": code},
            ) from exc
        kv = _bid_ask_to_kv(raw)
        return SpotQuote(
            market="a",
            code=code,
            last=_to_decimal(kv.get("最新"), label="last"),
            day_high=_to_decimal(kv.get("最高"), label="day_high"),
            day_low=_to_decimal(kv.get("最低"), label="day_low"),
            prev_close=_to_decimal(kv.get("昨收"), label="prev_close"),
            ts=datetime.now(UTC),
        )

    def _fetch_hk(self, code: str) -> SpotQuote:
        ak = self._require_ak()
        try:
            raw = ak.stock_hk_hist_min_em(symbol=code, period="1")
        except Exception as exc:
            raise QuantError(
                "WATCH_QUOTE_UPSTREAM_FAIL",
                f"{_NAME}: stock_hk_hist_min_em({code}) failed: {exc!r}",
                {"market": "hk", "code": code},
            ) from exc
        last, hi, lo = _minute_session_summary(raw, label=f"hk:{code}")
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
            ts=datetime.now(UTC),
        )

    def _fetch_us(self, code: str) -> SpotQuote:
        ak = self._require_ak()
        # Unlike the HK variant, ``stock_us_hist_min_em`` does NOT accept a
        # ``period`` kwarg (TypeError if passed). It also returns ALL minute
        # bars of the requested window — without a bound, that's the entire
        # available history. We only need session-level last/high/low, so a
        # 90-minute trailing window is plenty to cover the most recent bar
        # plus a buffer for early-tick delays.
        # The upstream endpoint filters server-side using ET wall-clock
        # (DST-aware). Passing UTC strings shifts the window 4-5h forward
        # in ET, which during the first half of a US session lands fully
        # in the future and yields an empty frame. Convert to ET first.
        end_et = datetime.now(_ET)
        start_et = end_et - timedelta(minutes=90)
        fmt = "%Y-%m-%d %H:%M:%S"
        try:
            raw = ak.stock_us_hist_min_em(
                symbol=code,
                start_date=start_et.strftime(fmt),
                end_date=end_et.strftime(fmt),
            )
        except Exception as exc:
            raise QuantError(
                "WATCH_QUOTE_UPSTREAM_FAIL",
                f"{_NAME}: stock_us_hist_min_em({code}) failed: {exc!r}",
                {"market": "us", "code": code},
            ) from exc
        last, hi, lo = _minute_session_summary(raw, label=f"us:{code}")
        prev_close = self._cached_prev_close(
            ("us", code),
            lambda: ak.stock_us_daily(symbol=code),
        )
        return SpotQuote(
            market="us",
            code=code,
            last=last,
            day_high=hi,
            day_low=lo,
            prev_close=prev_close,
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
        try:
            raw = fetch()
        except Exception as exc:
            raise QuantError(
                "WATCH_QUOTE_UPSTREAM_FAIL",
                f"{_NAME}: prev_close fetch failed for {key}: {exc!r}",
                {"market": key[0], "code": key[1]},
            ) from exc
        records = _to_records(raw, label=f"daily:{key[0]}:{key[1]}")
        if not records:
            raise QuantError(
                "WATCH_QUOTE_UPSTREAM_FAIL",
                f"{_NAME}: empty daily frame for {key}",
                {"market": key[0], "code": key[1]},
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
            {},
        )
    # ``stock_bid_ask_em`` returns rows like {"item": "最新", "value": 12.34}.
    if all("item" in r and "value" in r for r in records):
        return {str(r["item"]): r["value"] for r in records}
    # Fallback: a single wide row keyed by Chinese column name.
    return records[0]


def _minute_session_summary(raw: object, *, label: str) -> tuple[Decimal, Decimal, Decimal]:
    records = _to_records(raw, label=label)
    if not records:
        raise QuantError(
            "WATCH_QUOTE_UPSTREAM_FAIL",
            f"{_NAME}: empty minute frame for {label}",
            {"label": label},
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
            {"label": label},
        )
    return last, max(decimals_high), min(decimals_low)
