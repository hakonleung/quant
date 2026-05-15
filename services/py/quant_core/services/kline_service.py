"""K-line orchestration (modules/02-stock-kline.md §6, §7).

Glues the K-line source + repo + pure rules:

* :meth:`get_range` / :meth:`get_universe_slice` / :meth:`get_last_n` —
  read-only query API over the canonical store.
* :meth:`sync_code` — one-shot per-code sync. Fetches from akshare,
  assembles, and **returns** the bars to the caller (the Flight op
  handler). Persistence is owned by NestJS's ``KlineWriterService``
  (Phase 2 write flip); this service no longer touches disk on the
  write path.

The decision between backfill and recompute is purely watermark-based:
no factor-change short circuit, because ``adj_factor`` is not part of
the canonical schema after the storage-unify rollout. The cost of
re-fetching on a stale-watermark tick is one akshare call per code,
which the orchestrator already rate-limits.

Long-running orchestration across many codes lives in NestJS
(`docs/modules/09-update-orchestration.md`); this service handles the
single-code unit only.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Final, Literal

from quant_core.domain.rules.kline_assemble import assemble_daily_bars
from quant_core.domain.types.kline import KLINE_FLOOR_DATE
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import date

    import pyarrow as pa

    from quant_core.domain.types.kline import AdjFactor, DailyBar, RawDailyBar
    from quant_core.ports.clock import Clock
    from quant_core.ports.kline_repo import KlineRepo
    from quant_core.ports.kline_source import KlineSource


logger = logging.getLogger(__name__)


_DEFAULT_END_GAP_DAYS: Final[int] = 1


@dataclass(frozen=True, slots=True)
class KlineSyncReport:
    """Outcome of one per-code sync."""

    code: str
    mode: Literal["backfill", "incremental", "recompute", "skip"]
    fetched_bars: int
    written_bars: int
    new_last_date: date | None


class KlineService:
    """High-level operations on the canonical K-line store."""

    __slots__ = ("_clock", "_repo", "_source")

    def __init__(self, source: KlineSource, repo: KlineRepo, clock: Clock) -> None:
        self._source = source
        self._repo = repo
        self._clock = clock

    # -- read paths -----------------------------------------------------

    def get_range(
        self,
        code: str,
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table:
        if start > end:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"start ({start}) must be <= end ({end})",
            )
        clamped_start = max(start, KLINE_FLOOR_DATE)
        return self._repo.get_range(code, clamped_start, end, columns=columns)

    def get_universe_slice(
        self,
        codes: Sequence[str],
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table:
        if start > end:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"start ({start}) must be <= end ({end})",
            )
        clamped_start = max(start, KLINE_FLOOR_DATE)
        return self._repo.get_universe_slice(codes, clamped_start, end, columns=columns)

    def get_last_n(self, code: str, n: int) -> pa.Table:
        if n <= 0:
            raise QuantError("INVALID_ARGUMENT", f"n must be > 0, got {n}")
        last = self._repo.last_trade_date(code)
        if last is None:
            return self._repo.get_range(code, KLINE_FLOOR_DATE, KLINE_FLOOR_DATE)
        # Generous lower bound: trading calendar averages 250 days/yr; n
        # rows fit inside `n * 2` calendar days for any realistic n.
        # The repo trims to actually stored rows.
        approx_calendar_days = max(n * 2, 30)
        start = max(last - timedelta(days=approx_calendar_days), KLINE_FLOOR_DATE)
        table = self._repo.get_range(code, start, last)
        if table.num_rows <= n:
            return table
        return table.slice(table.num_rows - n, n)

    # -- write paths ----------------------------------------------------

    def sync_code(
        self, code: str, *, list_date: date | None = None, trace_id: str | None = None
    ) -> tuple[KlineSyncReport, list[DailyBar]]:
        """Pull bars for ``code`` and return them. Idempotent.

        Args:
            code: bare 6-digit A-share code.
            list_date: optional listing date; bounds the backfill lower edge.
            trace_id: optional correlation id propagated into log records.

        Returns:
            Tuple of (:class:`KlineSyncReport`, assembled bars). Persistence
            is the caller's responsibility — the Flight op handler streams
            ``bars`` back to NestJS and ``KlineWriterService.appendBars``
            writes them.

        Raises:
            QuantError: ``SOURCE_UNAVAILABLE`` when the source fails;
                ``EVALUATION_FAILED`` when the assembler rejects the data
                (e.g. non-positive prices, missing adj_factor baseline).
        """
        end = self._today()
        floor = self._effective_floor(list_date)
        if floor > end:
            return KlineSyncReport(code, "skip", 0, 0, None), []
        last = self._repo.last_trade_date(code)
        if last is None:
            return self._fetch_and_assemble(code, floor, end, "backfill", trace_id=trace_id)
        # Incremental window: (last_stored, end].
        next_start = last + timedelta(days=_DEFAULT_END_GAP_DAYS)
        if next_start > end:
            # Watermark already at "today"; skip without an akshare round-trip.
            # On ex-div days the orchestrator catches the recompute the next
            # business day when `end` advances past `last`.
            return KlineSyncReport(code, "skip", 0, 0, last), []
        # v1 takes the conservative path: any real append re-assembles the
        # union range so the rolling-MA window stays correct without a
        # second source round-trip. The faster "tail-only" §6.2 incremental
        # is tracked as a future optimisation.
        return self._fetch_and_assemble(code, floor, end, "recompute", trace_id=trace_id)

    # -- internals ------------------------------------------------------

    def _today(self) -> date:
        return self._clock.now().date()

    def _effective_floor(self, list_date: date | None) -> date:
        if list_date is None:
            return KLINE_FLOOR_DATE
        return max(KLINE_FLOOR_DATE, list_date)

    def _fetch_and_assemble(
        self,
        code: str,
        start: date,
        end: date,
        mode: Literal["backfill", "recompute"],
        *,
        trace_id: str | None = None,
    ) -> tuple[KlineSyncReport, list[DailyBar]]:
        raw_bars, factors = self._fetch_pair(code, start, end)
        if not raw_bars:
            return KlineSyncReport(code, mode, 0, 0, None), []
        bars = assemble_daily_bars(raw_bars, factors)
        last_date = bars[-1].trade_date
        logger.info(
            f"kline_{mode}_done",
            extra=_log_extra(code, len(bars), last_date, trace_id),
        )
        return (
            KlineSyncReport(code, mode, len(raw_bars), len(bars), last_date),
            bars,
        )

    def _fetch_pair(
        self, code: str, start: date, end: date
    ) -> tuple[list[RawDailyBar], list[AdjFactor]]:
        raw_bars = list(self._source.fetch_range(code, start, end))
        # Even if no bars came back (suspended stock, etc.), we still
        # return [] — caller decides what to do.
        if not raw_bars:
            return [], []
        # Pull factors on the actual covered window so the qfq baseline
        # is well-defined.
        factors = list(self._source.fetch_adj_factors(code, raw_bars[0].trade_date, end))
        return raw_bars, factors


def _log_extra(code: str, rows: int, last_date: date, trace_id: str | None) -> dict[str, object]:
    extra: dict[str, object] = {
        "code": code,
        "rows": rows,
        "last_date": last_date.isoformat(),
    }
    if trace_id is not None:
        extra["trace_id"] = trace_id
    return extra
