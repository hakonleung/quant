"""Helpers shared by every concrete :class:`WatchQuoteSource` adapter.

Extracted from :mod:`akshare_watch` when the second concrete adapter
(``yfinance_watch``) appeared — both need the same transport-error
classification, retry policy, and pandas-frame normalisation.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Final, cast

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Callable


# One quick retry for transient transport failures (Connection aborted /
# ProxyError / ChunkedEncodingError). Timeouts are NOT retried — they
# already burnt the per-tick budget; the next 3s tick will retry.
TRANSPORT_RETRY_DELAY_MS: Final[int] = 1000
TRANSPORT_RETRY_JITTER_MS: Final[int] = 100

# Exception-class-name allowlists. We match by ``__name__`` walking the
# MRO so we don't have to hard-depend on ``requests`` (the HTTP layer is
# an implementation detail of each adapter's SDK).
_TRANSPORT_EXC_NAMES: Final[frozenset[str]] = frozenset(
    {
        "ConnectionError",
        "ConnectionResetError",
        "ConnectionAbortedError",
        "ProxyError",
        "ChunkedEncodingError",
        "ProtocolError",
        "RemoteDisconnected",
        "IncompleteRead",
        "ContentDecodingError",
    }
)
_TIMEOUT_EXC_NAMES: Final[frozenset[str]] = frozenset(
    {"Timeout", "ReadTimeout", "ConnectTimeout", "ReadTimeoutError"}
)


def _classify_exc(exc: BaseException) -> str:
    """Return one of ``"transport" | "timeout" | "other"`` for routing.

    Walks the MRO so subclasses (e.g. ``requests.exceptions.ProxyError``
    → ``ConnectionError``) still match. ``transport`` is the only class
    we retry inline; the NestJS scheduler trips its per-market cooldown
    on the same flag.
    """
    for cls in type(exc).__mro__:
        name = cls.__name__
        if name in _TRANSPORT_EXC_NAMES:
            return "transport"
        if name in _TIMEOUT_EXC_NAMES:
            return "timeout"
    return "other"


def call_with_transport_retry(
    fn: Callable[[], object],
    *,
    market: str,
    code: str,
    label: str,
    backend: str,
    sleep: Callable[[float], None],
    jitter: Callable[[float, float], float],
) -> object:
    """Run ``fn`` and retry once on transport-class failures.

    On non-transport errors raises immediately; on transport errors
    sleeps ``TRANSPORT_RETRY_DELAY_MS`` ± jitter and retries one time.
    The raised :class:`QuantError` always carries a
    ``reason ∈ {"transport","timeout","other"}`` in ``details`` so the
    NestJS scheduler can trip its per-market cooldown, plus
    ``backend`` so logs can tell which adapter actually failed.
    """
    try:
        return fn()
    except Exception as exc:
        reason = _classify_exc(exc)
        if reason != "transport":
            raise QuantError(
                "WATCH_QUOTE_UPSTREAM_FAIL",
                f"{backend}: {label}({code}) failed: {exc!r}",
                {"market": market, "code": code, "reason": reason, "backend": backend},
            ) from exc
        delay_s = max(
            0.0,
            (
                TRANSPORT_RETRY_DELAY_MS
                + jitter(-TRANSPORT_RETRY_JITTER_MS, TRANSPORT_RETRY_JITTER_MS)
            )
            / 1000.0,
        )
        sleep(delay_s)
    try:
        return fn()
    except Exception as exc2:
        reason2 = _classify_exc(exc2)
        raise QuantError(
            "WATCH_QUOTE_UPSTREAM_FAIL",
            f"{backend}: {label}({code}) failed after retry: {exc2!r}",
            {
                "market": market,
                "code": code,
                "reason": reason2,
                "retried": True,
                "backend": backend,
            },
        ) from exc2


def _to_records(raw: object, *, label: str, backend: str) -> list[dict[str, object]]:
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
        f"{backend}: {label} returned unsupported container: {type(raw).__name__}",
        {"label": label, "backend": backend},
    )


def _to_decimal(v: object, *, label: str, backend: str) -> Decimal:
    """Coerce a Python/pandas scalar to ``Decimal`` or raise upstream-fail."""
    try:
        if v is None:
            raise ValueError("None")
        return Decimal(str(v))
    except (InvalidOperation, ValueError) as exc:
        raise QuantError(
            "WATCH_QUOTE_UPSTREAM_FAIL",
            f"{backend}: bad {label}: {v!r}",
            {"field": label, "backend": backend},
        ) from exc


def _decimal_or_zero(v: object) -> Decimal:
    """``_to_decimal`` that defaults missing / unparseable values to 0.

    Pre-open auction rows, holiday placeholders, and partial responses
    can lack cumulative fields. Treat those as 0 so the wire-format
    contract (positive-or-zero decimals) is still satisfied; the NestJS
    evaluator already guards against zero volume before computing vwap.
    """
    if v is None:
        return Decimal(0)
    try:
        s = str(v).strip()
        if s == "" or s.lower() in {"nan", "none"}:
            return Decimal(0)
        d = Decimal(s)
        return d if d >= 0 else Decimal(0)
    except (InvalidOperation, ValueError):
        return Decimal(0)


def _strip_us_prefix(code: str) -> str:
    """``"105.AAPL"`` -> ``"AAPL"``; bare tickers pass through unchanged."""
    head, sep, tail = code.partition(".")
    if sep == "" or not head.isdigit():
        return code
    return tail
