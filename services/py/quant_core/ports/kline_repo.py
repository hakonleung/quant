"""``KlineRepo`` domain port (modules/02-stock-kline.md §3).

Business interface for K-line persistence. Returns / accepts
:class:`pyarrow.Table` for read paths so the result stays zero-copy on
the way to Polars / Arrow Flight; write paths take :class:`DailyBar`
sequences (the canonical domain type).

The default Parquet implementation lives in
:mod:`quant_cache.parquet_kline_repo` and delegates row storage to the
generic :class:`TimeSeriesStore` port.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence
    from datetime import date

    import pyarrow as pa

    from quant_core.domain.types.kline import DailyBar


@runtime_checkable
class KlineRepo(Protocol):
    """Persistence port for :class:`DailyBar` rows."""

    def upsert_bars(self, code: str, bars: Iterable[DailyBar]) -> None:
        """Append (or replace overlapping rows) for one code.

        Caller guarantees ``bars`` are sorted ascending by trade_date and
        all share the same ``code``.
        """
        ...

    def overwrite_bars(self, code: str, bars: Iterable[DailyBar]) -> None:
        """Replace the entire history of ``code`` (used after ex-div recompute)."""
        ...

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
