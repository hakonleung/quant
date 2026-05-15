"""``KlineRepo`` domain port (modules/02-stock-kline.md §3).

Read-only port over the canonical K-line store. Persistence belongs to
NestJS's ``KlineWriterService`` since the Phase 2 write flip; this
service-layer port only describes the read surface the in-process
screen / pattern / blacklist consumers depend on.

The production adapter is :class:`quant_cache.flat_prefix_kline_repo.FlatPrefixKlineRepo`,
which reads ``<data_root>/kline/<prefix>.parquet`` (the same parquet
files NestJS writes via ``KlineWriterService``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import date

    import pyarrow as pa

    from quant_core.domain.types.kline import DailyBar


@runtime_checkable
class KlineRepo(Protocol):
    """Read-only persistence port for :class:`DailyBar` rows."""

    def get_range(
        self,
        code: str,
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table:
        """Slice [start, end] inclusive for a single code."""
        ...

    def get_universe_slice(
        self,
        codes: Sequence[str],
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table:
        """Cross-code slice [start, end] inclusive — used by screening."""
        ...

    def get_last_bar(self, code: str) -> DailyBar | None:
        """Most recent stored bar for ``code``, or ``None`` if empty."""
        ...

    def last_trade_date(self, code: str) -> date | None:
        """Latest stored trade_date for ``code``, or ``None`` if empty.

        Cheaper than :meth:`get_last_bar` when only the watermark is
        needed (incremental sync hot path).
        """
        ...
