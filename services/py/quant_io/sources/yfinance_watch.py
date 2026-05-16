"""yfinance-backed realtime US quote source for module W-0.

Yahoo's endpoints sit on a completely different IP family than the
East Money / Sina hosts AKShare proxies, so this adapter is the
preferred US fallback when those hosts rate-limit / IP-block the
machine running the Flight server. It only supports ``market="us"``
— ``a`` / ``hk`` raise ``INVALID_ARGUMENT`` so the routing layer
fails loudly instead of silently mis-dispatching.

Field mapping from ``yfinance.Ticker(bare).history(period, interval)``:

* ``last``      = last bar's ``Close``
* ``day_high``  = ``High.max()`` across the session window
* ``day_low``   = ``Low.min()`` across the session window
* ``volume``    = ``Volume.sum()`` across the bars
* ``amount``    = ``sum(Close_i * Volume_i)`` — yfinance does not expose a
                  per-bar turnover, so we approximate using the bar
                  close as a typical price. Good enough for the NestJS
                  VWAP baseline (consumer guards ``volume == 0``).
* ``prev_close`` = ``Ticker.fast_info["previousClose"]`` if available;
                   falls back to the second-to-last row of a 2-day daily
                   history. Cached per ``(market, code)`` for the UTC
                   trading day to keep tick latency down.
"""

from __future__ import annotations

import random
import time
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Final, Protocol, cast, runtime_checkable

from quant_core.domain.types.watch import SpotQuote, WatchMarket
from quant_core.errors import QuantError

from quant_io.sources._common import lazy_import
from quant_io.sources._watch_common import (
    _decimal_or_zero,
    _strip_us_prefix,
    _to_decimal,
    _to_records,
    call_with_transport_retry,
)

if TYPE_CHECKING:
    from collections.abc import Callable


_NAME: Final[str] = "yfinance_watch"
# 1-day window of 1-minute bars covers a full US RTH session even when
# the call lands near close — yfinance returns only bars that have
# already printed, so the payload self-bounds to "since open today".
_HIST_PERIOD: Final[str] = "1d"
_HIST_INTERVAL: Final[str] = "1m"
# Class names that mark a Yahoo rate-limit. We match by name (walking
# the MRO) instead of importing ``yfinance.exceptions`` so test gateways
# can inject fakes without dragging in the real yfinance import.
_RATE_LIMIT_EXC_NAMES: Final[frozenset[str]] = frozenset({"YFRateLimitError", "YFRateLimit"})


def _is_rate_limit(exc: BaseException | None) -> bool:
    if exc is None:
        return False
    return any(cls.__name__ in _RATE_LIMIT_EXC_NAMES for cls in type(exc).__mro__)


def _make_impersonated_session() -> object | None:
    """Return a ``curl_cffi.requests.Session`` posing as Chrome, if available.

    Yahoo's chart endpoint heavily rate-limits the vanilla ``requests``
    UA + TLS fingerprint that yfinance uses by default; curl_cffi's
    chrome impersonation bypasses that. The session is best-effort —
    if ``curl_cffi`` isn't importable or the impersonation kwarg is
    rejected we fall back to vanilla yfinance and accept the higher
    rate-limit risk.
    """
    mod = lazy_import("curl_cffi.requests")
    if mod is None:
        return None
    session_cls = getattr(mod, "Session", None)
    if session_cls is None:
        return None
    try:
        session: object = session_cls(impersonate="chrome")
    except Exception:  # noqa: BLE001 — best-effort, see docstring
        return None
    return session


class _DefaultYFinanceGateway:
    """Production gateway: shares one impersonated session across tickers.

    yfinance.Ticker accepts a ``session=`` kwarg; passing a single
    long-lived curl_cffi session keeps cookies + TLS fingerprint
    stable, which is what tips Yahoo's rate-limiter from "throttle"
    into "normal browser traffic".
    """

    __slots__ = ("_session", "_ticker_cls")

    def __init__(self, yf_mod: object, session: object | None) -> None:
        self._ticker_cls = getattr(yf_mod, "Ticker")  # noqa: B009 — runtime attr
        self._session = session

    def Ticker(self, symbol: str) -> _YFinanceTicker:  # noqa: N802 — matches yfinance API
        if self._session is not None:
            return cast("_YFinanceTicker", self._ticker_cls(symbol, session=self._session))
        return cast("_YFinanceTicker", self._ticker_cls(symbol))


@runtime_checkable
class _YFinanceTicker(Protocol):
    """Minimal duck-typed view of ``yfinance.Ticker``.

    Returned ``object`` from ``history`` is a pandas DataFrame in the
    real SDK; we go through :func:`_to_records` so tests can pass a
    list-of-dicts without importing pandas.
    """

    def history(self, *, period: str, interval: str, prepost: bool) -> object: ...

    # ``fast_info`` is a ``yfinance.utils.YfData`` proxy — mapping-like
    # access (``.get`` / ``__getitem__``) returns the cached scalar.
    @property
    def fast_info(self) -> object: ...


@runtime_checkable
class _YFinanceGateway(Protocol):
    def Ticker(self, symbol: str) -> _YFinanceTicker: ...  # noqa: N802 — matches yfinance API


class YFinanceWatchSource:
    """Implements :class:`WatchQuoteSource` for ``market="us"`` only.

    A/HK markets raise ``INVALID_ARGUMENT`` — the routing layer is
    expected to keep those on AKShare.
    """

    __slots__ = ("_gateway", "_jitter", "_prev_close_cache", "_sleep")

    def __init__(
        self,
        *,
        gateway: _YFinanceGateway | None = None,
        sleep: Callable[[float], None] | None = None,
        jitter: Callable[[float, float], float] | None = None,
    ) -> None:
        # ``gateway`` injection is for tests; production lazy-imports the
        # real module so a missing optional dep surfaces as a runtime
        # ``WATCH_QUOTE_UPSTREAM_FAIL`` rather than crashing at import.
        if gateway is None:
            yf_mod = lazy_import("yfinance")
            if yf_mod is None:
                self._gateway: _YFinanceGateway | None = None
            else:
                session = _make_impersonated_session()
                self._gateway = _DefaultYFinanceGateway(yf_mod, session)
        else:
            self._gateway = gateway
        self._prev_close_cache: dict[tuple[str, str], tuple[date, Decimal]] = {}
        self._sleep: Callable[[float], None] = sleep if sleep is not None else time.sleep
        self._jitter: Callable[[float, float], float] = (
            jitter if jitter is not None else random.uniform
        )

    def _call_yf(
        self,
        fn: Callable[[], object],
        *,
        code: str,
        label: str,
    ) -> object:
        """Run ``fn`` with transport retry and YFRateLimit translation.

        Yahoo rate-limits get surfaced with ``reason="rate_limited"`` so
        the NestJS scheduler can apply a longer per-market cooldown
        than the standard transport backoff. We don't retry rate-limit
        errors inline — Yahoo's window is minutes, not seconds, and
        immediate retry would just consume the next tick's budget.
        """
        try:
            return call_with_transport_retry(
                fn,
                market="us",
                code=code,
                label=label,
                backend=_NAME,
                sleep=self._sleep,
                jitter=self._jitter,
            )
        except QuantError as qe:
            if _is_rate_limit(qe.__cause__):
                raise QuantError(
                    "WATCH_QUOTE_UPSTREAM_FAIL",
                    f"{_NAME}: {label}({code}) rate-limited by Yahoo: {qe.__cause__!r}",
                    {
                        "market": "us",
                        "code": code,
                        "reason": "rate_limited",
                        "backend": _NAME,
                    },
                ) from qe.__cause__
            raise

    def _require_gateway(self) -> _YFinanceGateway:
        if self._gateway is None:
            raise QuantError(
                "WATCH_QUOTE_UPSTREAM_FAIL",
                f"{_NAME}: yfinance not installed",
                {"reason": "import_failed", "backend": _NAME},
            )
        return self._gateway

    def fetch_one(self, market: WatchMarket, code: str) -> SpotQuote:
        if market != "us":
            raise QuantError(
                "INVALID_ARGUMENT",
                f"{_NAME}: only supports market='us', got {market!r}",
                {"market": market, "backend": _NAME},
            )
        gw = self._require_gateway()
        bare = _strip_us_prefix(code)
        ticker = gw.Ticker(bare)

        raw = self._call_yf(
            lambda: ticker.history(
                period=_HIST_PERIOD,
                interval=_HIST_INTERVAL,
                prepost=False,
            ),
            code=code,
            label="ticker.history",
        )
        last, hi, lo, amount, volume = _session_summary(raw, code=code)

        prev_close = self._cached_prev_close(("us", code), ticker)

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
        ticker: _YFinanceTicker,
    ) -> Decimal:
        today = datetime.now(UTC).date()
        cached = self._prev_close_cache.get(key)
        if cached is not None and cached[0] == today:
            return cached[1]

        # Try fast_info first (single HTTP roundtrip cached by yfinance).
        # If it's missing the field or raises, fall back to a 2-day daily
        # history pull.
        prev_close = _fast_info_prev_close(ticker)
        if prev_close is None:
            raw = self._call_yf(
                lambda: ticker.history(period="2d", interval="1d", prepost=False),
                code=key[1],
                label="ticker.history.daily",
            )
            records = _to_records(raw, label=f"daily:{key[0]}:{key[1]}", backend=_NAME)
            if not records:
                raise QuantError(
                    "WATCH_QUOTE_UPSTREAM_FAIL",
                    f"{_NAME}: empty daily frame for {key}",
                    {"market": key[0], "code": key[1], "backend": _NAME},
                )
            # `history(period="2d")` returns either two completed sessions
            # or one completed + one running session. Either way the
            # second-to-last row, if present, is the previous trading
            # day's close; a 1-row frame means today is the only printed
            # session and we use it as the best available baseline.
            row = records[-2] if len(records) >= 2 else records[-1]
            prev_close = _to_decimal(
                row.get("Close", row.get("close")),
                label="prev_close",
                backend=_NAME,
            )
        self._prev_close_cache[key] = (today, prev_close)
        return prev_close


def _fast_info_prev_close(ticker: _YFinanceTicker) -> Decimal | None:
    """Best-effort extraction of ``previousClose`` from ``fast_info``.

    ``fast_info`` raises on the first network attempt if Yahoo refuses
    the lazy-loaded request; we swallow that and let the caller fall
    back to a daily-history pull. The boundary catch is intentional —
    this is the one place where we want fast_info failures to NOT poison
    the whole tick.
    """
    try:
        fi = ticker.fast_info
    except Exception:  # noqa: BLE001 — fast_info boundary, see docstring
        return None
    getter = getattr(fi, "get", None)
    raw: object
    if callable(getter):
        raw = getter("previousClose", None)
    else:
        try:
            raw = fi["previousClose"]  # type: ignore[index]  # mapping-like proxy
        except Exception:  # noqa: BLE001 — proxy access boundary
            return None
    if raw is None:
        return None
    try:
        return _to_decimal(raw, label="prev_close", backend=_NAME)
    except QuantError:
        return None


def _session_summary(
    raw: object, *, code: str
) -> tuple[Decimal, Decimal, Decimal, Decimal, Decimal]:
    """Return ``(last, day_high, day_low, amount_total, volume_total)``.

    Iterates the minute frame once and computes everything together.
    ``amount`` is approximated as ``sum(Close_i * Volume_i)`` because
    yfinance doesn't expose per-bar turnover; this is the standard
    typical-price proxy and only feeds the NestJS VWAP baseline.
    """
    label = f"us:{code}"
    records = _to_records(raw, label=label, backend=_NAME)
    if not records:
        raise QuantError(
            "WATCH_QUOTE_UPSTREAM_FAIL",
            f"{_NAME}: empty minute frame for {label}",
            {"label": label, "backend": _NAME},
        )
    # yfinance DataFrames use capitalised column names (Open / High /
    # Low / Close / Volume) — but tests sometimes pass lowercased rows,
    # so we tolerate both.
    last_row = records[-1]
    last = _to_decimal(
        last_row.get("Close", last_row.get("close")),
        label="last",
        backend=_NAME,
    )
    highs: list[Decimal] = []
    lows: list[Decimal] = []
    amount_total = Decimal(0)
    volume_total = Decimal(0)
    for r in records:
        h = r.get("High", r.get("high"))
        if h is not None:
            highs.append(_to_decimal(h, label="day_high", backend=_NAME))
        lv = r.get("Low", r.get("low"))
        if lv is not None:
            lows.append(_to_decimal(lv, label="day_low", backend=_NAME))
        close_v = _decimal_or_zero(r.get("Close", r.get("close")))
        vol_v = _decimal_or_zero(r.get("Volume", r.get("volume")))
        volume_total += vol_v
        amount_total += close_v * vol_v
    if not highs or not lows:
        raise QuantError(
            "WATCH_QUOTE_UPSTREAM_FAIL",
            f"{_NAME}: missing high/low columns in {label}",
            {"label": label, "backend": _NAME},
        )
    return last, max(highs), min(lows), amount_total, volume_total
