"""A-share blacklist computation (`docs/modules/12-blacklist.md`).

Daily cron walks the meta universe + cached kline and tags any A-share
code whose stage returns are uniformly weak as "noise" — the NestJS
gateway then skips meta sync for these and slows kline sync to a 10-day
heartbeat (see `apps/api/src/modules/blacklist/`).

Criteria: a code is blacklisted iff it satisfies **none** of

    20-trading-day return  > 30 %
    90-trading-day return  > 60 %
    250-trading-day return > 100 %

Returns are cumulative over the last `n` available rows of `close_qfq`
(the precomputed forward-adjusted close that `KlineService` writes at
ingest time — `docs/modules/02-kline.md`).

Codes with fewer than 21 cached daily rows are **not** blacklisted —
brand-new IPOs lack the data to judge, and the cron will revisit them
once enough history accumulates.

Pure-ish: the only IO is reading kline files via the injected
`ParquetKlineRepo`; no network, no clocks except the injected one.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import TYPE_CHECKING, Final, Protocol, runtime_checkable

import pyarrow as pa

if TYPE_CHECKING:
    from collections.abc import Sequence

    from quant_core.domain.types.stock import StockMeta
    from quant_core.ports.clock import Clock


@runtime_checkable
class _MetaSource(Protocol):
    """Minimal slice of ``ParquetStockMetaRepo`` this service needs."""

    def list_all(self) -> list[StockMeta]: ...


@runtime_checkable
class _KlineSource(Protocol):
    """Minimal slice of ``ParquetKlineRepo`` this service needs."""

    def get_range(
        self,
        code: str,
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table: ...


# (window_in_trading_days, fractional return threshold)
_THRESHOLDS: Final[tuple[tuple[int, float], ...]] = (
    (20, 0.30),
    (90, 0.60),
    (250, 1.00),
)
_MIN_ROWS: Final[int] = 21
# Calendar days back for the kline read — comfortably > 250 trading days
# (allowing for weekends + holidays + suspensions).
_LOOKBACK_CALENDAR_DAYS: Final[int] = 400


@dataclass(frozen=True, slots=True)
class BlacklistResult:
    """Output of :func:`compute_ashare_blacklist`."""

    codes: tuple[str, ...]
    """Sorted A-share codes that failed every stage-return threshold."""
    asof: date
    """The reference date (clock today) the cron used for the cutoff."""
    universe_size: int
    """Total A-share codes considered (helps detect upstream meta drift)."""


def compute_ashare_blacklist(
    *,
    meta_repo: _MetaSource,
    kline_repo: _KlineSource,
    clock: Clock,
) -> BlacklistResult:
    """Walk the A-share universe, compute stage returns, return blacklist.

    Args:
        meta_repo: source of the A-share code list (`list_all`).
        kline_repo: per-code Parquet store of OHLCV + qfq + ma columns.
        clock: injected for testability — `clock.now().date()` is the
            reference end-date for stage returns.

    Returns:
        :class:`BlacklistResult` with the sorted blacklist and run metadata.
    """
    today = clock.now().date()
    start = today - timedelta(days=_LOOKBACK_CALENDAR_DAYS)
    blacklisted: list[str] = []
    universe = list(meta_repo.list_all())
    for meta in universe:
        if _is_blacklisted(meta.code, start=start, end=today, kline_repo=kline_repo):
            blacklisted.append(meta.code)
    blacklisted.sort()
    return BlacklistResult(
        codes=tuple(blacklisted),
        asof=today,
        universe_size=len(universe),
    )


def _is_blacklisted(
    code: str,
    *,
    start: date,
    end: date,
    kline_repo: _KlineSource,
) -> bool:
    """Decide one code. False iff insufficient data OR any threshold passes."""
    table = kline_repo.get_range(code, start, end, columns=["close_qfq"])
    n = table.num_rows
    if n < _MIN_ROWS:
        return False
    closes = table.column("close_qfq").to_pylist()
    latest_raw = closes[-1]
    if latest_raw is None:
        return False
    latest = float(latest_raw)
    if latest <= 0:
        return False
    checked_any = False
    for window, threshold in _THRESHOLDS:
        if n < window + 1:
            continue
        past_raw = closes[-1 - window]
        if past_raw is None:
            continue
        past = float(past_raw)
        if past <= 0:
            continue
        checked_any = True
        ret = (latest - past) / past
        if ret > threshold:
            return False
    return checked_any
