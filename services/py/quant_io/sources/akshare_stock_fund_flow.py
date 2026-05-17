"""AKShare-backed DDE 主力 fund-flow rank source.

Wraps ``ak.stock_fund_flow_individual(symbol="N日排行")`` (10jqka /
同花顺) — the only akshare endpoint that ships the 20-day window the
project ships out of the box. The east-money cousin
(``stock_individual_fund_flow_rank``) tops out at 10 days and uses
``push2.eastmoney.com``, which our outbound proxy can't reach
reliably; switching upstreams costs us nothing because the口径 (主力
净流入 = 超大单 + 大单) is the same on both vendors.

Each call returns the full A-share rank for one window (~5500 rows in
~30 s, 4 windows ≈ 2 min total). The "资金流入净额" column is a
unit-suffixed string ("-4.09亿", "1234.5万", "-678") — we parse to a
signed CNY ``Decimal`` (元) at the source boundary so downstream sees
unified numerics. ``股票代码`` arrives as an ``int`` (Shenzhen codes
lose their leading zero in pandas type coercion), so we zero-pad to 6
digits before filtering.

Codes that yield a non-parseable value get ``None`` rather than being
dropped — preserves "no data" vs "real zero" distinguishability for
downstream ratio math.
"""

from __future__ import annotations

import logging
import time
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Final, Protocol, runtime_checkable

from quant_core.domain.types.fund_flow import DDE_WINDOWS
from quant_core.errors import QuantError

from quant_io.sources._common import lazy_import

if TYPE_CHECKING:
    from collections.abc import Mapping


_logger = logging.getLogger(__name__)

_INDICATOR_FOR_WINDOW: Final[dict[int, str]] = {
    3: "3日排行",
    5: "5日排行",
    10: "10日排行",
    20: "20日排行",
}


@runtime_checkable
class _AkshareGateway(Protocol):
    def stock_fund_flow_individual(self, symbol: str) -> object: ...


class AKShareFundFlowRankSource:
    """One-window rank fetcher.

    Args:
        gateway: Optional duck-typed gateway for tests. Production
            lazy-imports akshare on first use.
    """

    __slots__ = ("_gateway",)

    def __init__(self, *, gateway: _AkshareGateway | None = None) -> None:
        self._gateway = gateway

    def fetch_rank(self, window: int) -> dict[str, Decimal | None]:
        """Pull the full-market 主力净流入 rank for ``window`` days.

        Args:
            window: Trailing-day window; must be in :data:`DDE_WINDOWS`.

        Returns:
            ``{code: main_net_inflow_in_yuan_or_None}``. Codes whose row
            carried a non-numeric ``--`` are present with value ``None``;
            rows with non-6-digit codes are filtered out (avoids HK /
            US tickers sneaking in through aggregated boards).

        Raises:
            QuantError: ``INVALID_ARGUMENT`` for an unknown window;
                ``SOURCE_UNAVAILABLE`` when akshare isn't importable or
                the call raised — the rank endpoint is all-or-nothing,
                so any failure surfaces (caller decides whether to skip
                that window or abort the batch).
        """
        if window not in _INDICATOR_FOR_WINDOW:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"unknown DDE window: {window!r}; expected one of {sorted(DDE_WINDOWS)}",
            )
        gw = self._resolve_gateway()
        indicator = _INDICATOR_FOR_WINDOW[window]
        t0 = time.monotonic()
        try:
            raw = gw.stock_fund_flow_individual(symbol=indicator)
        except Exception as exc:  # noqa: BLE001 — adapter boundary
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                f"stock_fund_flow_individual({indicator!r}) failed: {_short_repr(exc)}",
                {"indicator": indicator, "window": window},
            ) from exc
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        records = _iter_records(raw)
        out: dict[str, Decimal | None] = {}
        for row in records:
            code = _normalise_code(row.get("股票代码") or row.get("代码"))
            if code is None:
                continue
            # 10jqka 列名：rank views 用 "资金流入净额"，"即时" view 用 "净额"
            raw_value = row.get("资金流入净额") if "资金流入净额" in row else row.get("净额")
            out[code] = _parse_cny_unit(raw_value)
        _logger.info(
            "fund_flow_rank_ok indicator=%s rows=%d elapsed_ms=%d",
            indicator,
            len(out),
            elapsed_ms,
        )
        return out

    def _resolve_gateway(self) -> _AkshareGateway:
        if self._gateway is not None:
            return self._gateway
        ak = lazy_import("akshare")
        if ak is None:
            raise QuantError("SOURCE_UNAVAILABLE", "akshare package not installed")
        if not isinstance(ak, _AkshareGateway):
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                "akshare module missing stock_fund_flow_individual",
            )
        self._gateway = ak
        return ak


# -- internal helpers --------------------------------------------------------


def _iter_records(raw: object) -> list[Mapping[str, object]]:
    """Coerce a pandas DataFrame / list[dict] → list of mappings."""
    to_dict = getattr(raw, "to_dict", None)
    if callable(to_dict):
        records = to_dict("records")
        if isinstance(records, list):
            return records
    if isinstance(raw, list):
        return raw
    return []


def _normalise_code(value: object) -> str | None:
    """Coerce a 10jqka 股票代码 cell to a zero-padded 6-digit string.

    The endpoint returns codes as ``int`` (pandas type inference), so
    ``1393`` arrives instead of ``"001393"``. We zero-pad and accept only
    pure-digit values that resolve to a 6-character code; anything else
    (HK / US tickers, ``nan``, header rows) yields ``None`` so the
    caller can drop the row.
    """
    if value is None:
        return None
    if isinstance(value, int):
        if value < 0 or value > 999_999:
            return None
        return f"{value:06d}"
    s = str(value).strip()
    if not s or s.lower() == "nan":
        return None
    if not s.isdigit() or len(s) > 6:
        return None
    return s.zfill(6)


_UNIT_FACTORS: Final[dict[str, Decimal]] = {
    "亿": Decimal(10**8),
    "万": Decimal(10**4),
    "千": Decimal(10**3),
}


def _parse_cny_unit(value: object) -> Decimal | None:
    """Parse a 10jqka unit-suffixed CNY string into 元 ``Decimal``.

    Accepted forms (case-insensitive on the unit):

    * ``"-4.09亿"`` → ``Decimal("-409000000")``
    * ``"1234.5万"`` → ``Decimal("12345000")``
    * ``"-678"`` (bare 元) → ``Decimal("-678")``
    * ``"--"`` / ``"nan"`` / empty → ``None``

    Decimal numbers without a unit are treated as already-在元-scale;
    upstream emits unit-less strings only for very small values, so we
    don't try to second-guess them.
    """
    if value is None:
        return None
    s = str(value).strip().replace(",", "")
    if not s or s.lower() == "nan" or s == "--":
        return None
    factor = Decimal(1)
    if s and s[-1] in _UNIT_FACTORS:
        factor = _UNIT_FACTORS[s[-1]]
        s = s[:-1].strip()
    try:
        return Decimal(s) * factor
    except InvalidOperation:
        return None


def _short_repr(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc!s}"[:200]
