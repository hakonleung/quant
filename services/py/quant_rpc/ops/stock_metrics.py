"""Flight op: refresh a stock's persisted metrics block.

NestJS's ``KlineWorker.process`` calls this once per code right after a
fresh kline batch has been written. The handler reads the local meta +
kline cache, runs :func:`compute_metrics`, and writes the result back
into ``data/meta/stocks.parquet`` via ``StockMetaRepo.upsert_many``.

Returns a one-row report so the worker can confirm a hit; empty table
when the code is unknown to the meta repo (e.g. the cron is syncing a
freshly-listed stock that hasn't been onboarded yet).

A note on cost: ``ParquetStockMetaRepo.upsert_many`` rewrites the whole
``stocks.parquet`` per call. For an interactive cron that's fine (a
single ~5 MB file); a one-shot universe backfill that fires this op
5500 times in a row will hit the same file 5500 times — fold those into
a batched op when load proves it matters
(``docs/perf/storage-unify-rollout.md`` "next moves" #1 mentions this).
"""

from __future__ import annotations

import dataclasses
from datetime import timedelta
from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_cache.kline_schema import daily_bar_from_row
from quant_core.domain.pure.compute_metrics import StockMetrics, compute_metrics
from quant_core.domain.types.stock import PersistedMetrics
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.domain.types.kline import DailyBar
    from quant_core.ports.clock import Clock
    from quant_core.ports.kline_repo import KlineRepo
    from quant_core.ports.stock_meta_repo import StockMetaRepo


_OP: Final[str] = "upsert_stock_metrics_for_code"

UPSERT_METRICS_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("asof", pa.date32()),
        ("written", pa.bool_()),
    ]
)


def _require_code(args: Mapping[str, object]) -> str:
    raw = args.get("code")
    if not isinstance(raw, str) or not raw:
        raise QuantError(
            "INVALID_ARGUMENT",
            "args.code must be a non-empty string",
            {"key": "code"},
        )
    return raw


class UpsertStockMetricsForCodeHandler:
    """``upsert_stock_metrics_for_code`` — refresh one code's metrics block."""

    op = _OP
    schema = UPSERT_METRICS_SCHEMA

    __slots__ = ("_clock", "_kline_repo", "_meta_repo")

    def __init__(
        self,
        meta_repo: StockMetaRepo,
        kline_repo: KlineRepo,
        clock: Clock,
    ) -> None:
        self._meta_repo = meta_repo
        self._kline_repo = kline_repo
        self._clock = clock

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        code = _require_code(args)
        meta = self._meta_repo.get(code)
        if meta is None:
            # No meta row → nothing to project onto. Worker logs the miss
            # and moves on; this is expected during the brief window
            # between a new listing and the next meta-sync cron tick.
            return UPSERT_METRICS_SCHEMA.empty_table()
        last_date = self._kline_repo.last_trade_date(code)
        bars: list[DailyBar] = []
        if last_date is not None:
            # 400 calendar days covers the 250-trading-day window with
            # cushion for non-trading days; the projector slices internally.
            start = last_date - timedelta(days=400)
            table = self._kline_repo.get_range(code, start, last_date)
            bars = [daily_bar_from_row(r) for r in table.to_pylist()]
        metrics = compute_metrics(meta, bars)
        now = self._clock.now()
        new_meta = dataclasses.replace(
            meta,
            metrics=_persisted_from_computed(metrics),
            metrics_updated_at=now,
        )
        self._meta_repo.upsert_many([new_meta])
        return pa.Table.from_pylist(
            [{"code": code, "asof": metrics.asof, "written": True}],
            schema=UPSERT_METRICS_SCHEMA,
        )


def _persisted_from_computed(m: StockMetrics) -> PersistedMetrics:
    return PersistedMetrics(
        asof=m.asof,
        ret_1d=m.ret_1d,
        ret_5d=m.ret_5d,
        ret_10d=m.ret_10d,
        ret_20d=m.ret_20d,
        ret_90d=m.ret_90d,
        ret_250d=m.ret_250d,
        mkt_cap=m.mkt_cap,
        float_mkt_cap=m.float_mkt_cap,
        pe_ttm=m.pe_ttm,
        pe_dynamic=m.pe_dynamic,
        pb=m.pb,
        peg=m.peg,
        gross_margin_ttm=m.gross_margin_ttm,
    )
