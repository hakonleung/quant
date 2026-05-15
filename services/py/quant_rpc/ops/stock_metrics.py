"""Flight ops: refresh persisted metrics blocks on ``stock_meta``.

Two variants share the same projector core (:func:`compute_metrics`):

* ``upsert_stock_metrics_for_code`` — refresh exactly one code. Called
  from NestJS's ``KlineWorker.process`` right after every per-code
  kline sync. One parquet rewrite per call; cheap at cron rates.
* ``upsert_stock_metrics_for_codes`` — batched variant. Reads the
  whole batch in one ``get_universe_slice`` query and writes the
  updated meta rows in a single ``upsert_many`` so the cold-start
  backfill doesn't rewrite ``stocks.parquet`` 5500 times. Empty
  ``codes`` means "every code the meta repo knows about".
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
_BATCH_OP: Final[str] = "upsert_stock_metrics_for_codes"

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


def _optional_code_list(args: Mapping[str, object], key: str) -> list[str]:
    raw = args.get(key)
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a list of strings",
            {"got": type(raw).__name__},
        )
    out: list[str] = []
    for i, value in enumerate(raw):
        if not isinstance(value, str):
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.{key}[{i}] must be a string",
                {"index": i, "got": type(value).__name__},
            )
        out.append(value)
    return out


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
        bars = _bars_for_code(self._kline_repo, code)
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


class UpsertStockMetricsForCodesHandler:
    """``upsert_stock_metrics_for_codes`` — batched projector.

    One ``upsert_many`` for the whole batch — the meta parquet is
    rewritten once instead of N times. Codes missing from the meta repo
    are silently dropped. Codes whose kline cache is empty still get a
    row written with ``asof = None`` so the persisted block reflects the
    "no bars yet" state.
    """

    op = _BATCH_OP
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
        codes = _optional_code_list(args, "codes")
        if not codes:
            # Empty codes → expand to full meta universe (mirrors the
            # other batch ops in this file).
            metas = self._meta_repo.list_all()
        else:
            metas = self._meta_repo.get_many(codes)
        if not metas:
            return UPSERT_METRICS_SCHEMA.empty_table()
        now = self._clock.now()
        new_metas: list[object] = []
        rows: list[dict[str, object]] = []
        for meta in metas:
            bars = _bars_for_code(self._kline_repo, meta.code)
            metrics = compute_metrics(meta, bars)
            new_metas.append(
                dataclasses.replace(
                    meta,
                    metrics=_persisted_from_computed(metrics),
                    metrics_updated_at=now,
                )
            )
            rows.append({"code": meta.code, "asof": metrics.asof, "written": True})
        # One parquet rewrite for the whole batch — the win this op
        # exists for.
        self._meta_repo.upsert_many(new_metas)  # type: ignore[arg-type]
        return pa.Table.from_pylist(rows, schema=UPSERT_METRICS_SCHEMA)


def _bars_for_code(kline_repo: "KlineRepo", code: str) -> "list[DailyBar]":
    """Read the trailing 400-calendar-day window for one code.

    Shared between the single and batched handlers so the cost model
    stays identical (one ``get_range`` per code; the batched variant
    just dedups the ``upsert_many``).
    """
    last_date = kline_repo.last_trade_date(code)
    if last_date is None:
        return []
    start = last_date - timedelta(days=400)
    table = kline_repo.get_range(code, start, last_date)
    return [daily_bar_from_row(r) for r in table.to_pylist()]


def _persisted_from_computed(m: StockMetrics) -> PersistedMetrics:
    return PersistedMetrics(
        asof=m.asof,
        price=m.price,
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
