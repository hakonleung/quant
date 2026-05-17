"""AKShare-backed DDE 主力 fund-flow rank source.

Wraps ``ak.stock_individual_fund_flow_rank(indicator=...)``. One call
per window returns the full A-share market, so the four configured
windows in :data:`DDE_WINDOWS` cost exactly four HTTP RTTs total.

The endpoint's column names are prefixed by the ``indicator`` value
(e.g. ``"3日主力净流入-净额"`` for ``indicator="3日"``). We select the
``主力净流入-净额`` column for each window — that's super-large + large
order net inflow, the口径 the user pinned at planning time.

Codes that come back as ``--`` (delisted / suspended) yield ``None`` for
that window rather than skipping the row, so a downstream consumer can
emit "no data" instead of confusing a missing row with a real zero.
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

_INDICATOR_FOR_WINDOW: Final[dict[int, str]] = {3: "3日", 5: "5日", 10: "10日", 20: "20日"}


@runtime_checkable
class _AkshareGateway(Protocol):
    def stock_individual_fund_flow_rank(self, indicator: str) -> object: ...


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
            raw = gw.stock_individual_fund_flow_rank(indicator=indicator)
        except Exception as exc:  # noqa: BLE001 — adapter boundary
            raise QuantError(
                "SOURCE_UNAVAILABLE",
                f"stock_individual_fund_flow_rank({indicator!r}) failed: {_short_repr(exc)}",
                {"indicator": indicator, "window": window},
            ) from exc
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        records = _iter_records(raw)
        col = f"{indicator}主力净流入-净额"
        out: dict[str, Decimal | None] = {}
        for row in records:
            code = _str(row.get("代码") or row.get("股票代码"))
            if not _is_valid_code(code):
                continue
            out[code] = _to_decimal(row.get(col))
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
                "akshare module missing stock_individual_fund_flow_rank",
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


def _is_valid_code(code: str) -> bool:
    return code.isdigit() and len(code) == 6


def _str(value: object) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    return "" if s.lower() == "nan" else s


def _to_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s or s.lower() == "nan" or s == "--":
        return None
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def _short_repr(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc!s}"[:200]
