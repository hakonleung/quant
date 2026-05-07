"""Flight op for the A-share noise-reduction blacklist.

* ``compute_ashare_blacklist`` — runs :func:`compute_ashare_blacklist`
  and returns the resulting code list as a single-column Arrow table.
  No args. The NestJS gateway invokes this nightly via cron, persists
  the result to ``data/blacklist.json``, and serves it to the frontend
  via ``GET /api/blacklist``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import pyarrow as pa

from quant_core.services.blacklist_service import compute_ashare_blacklist

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_cache.parquet_kline_repo import ParquetKlineRepo
    from quant_cache.parquet_stock_meta_repo import ParquetStockMetaRepo
    from quant_core.ports.clock import Clock


_OP: Final[str] = "compute_ashare_blacklist"


BLACKLIST_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        pa.field("code", pa.string()),
        pa.field("asof", pa.date32()),
        pa.field("universe_size", pa.int32()),
    ]
)


class ComputeAshareBlacklistHandler:
    """``compute_ashare_blacklist`` — no args; returns ``(code, asof, universe_size)`` rows.

    ``asof`` and ``universe_size`` are repeated on every row so the
    NestJS reader can pick them off the first record without a
    side-channel JSON envelope. Empty blacklist yields an empty table.
    """

    op = _OP
    schema = BLACKLIST_SCHEMA

    __slots__ = ("_clock", "_kline_repo", "_meta_repo")

    def __init__(
        self,
        *,
        meta_repo: ParquetStockMetaRepo,
        kline_repo: ParquetKlineRepo,
        clock: Clock,
    ) -> None:
        self._meta_repo = meta_repo
        self._kline_repo = kline_repo
        self._clock = clock

    def execute(self, _args: Mapping[str, object]) -> pa.Table:
        result = compute_ashare_blacklist(
            meta_repo=self._meta_repo,
            kline_repo=self._kline_repo,
            clock=self._clock,
        )
        if not result.codes:
            return BLACKLIST_SCHEMA.empty_table()
        rows = [
            {"code": c, "asof": result.asof, "universe_size": result.universe_size}
            for c in result.codes
        ]
        return pa.Table.from_pylist(rows, schema=BLACKLIST_SCHEMA)
