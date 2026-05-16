"""Flight ops: compute persisted metrics blocks; **storage is NestJS-owned**.

Two variants share the same projector core (:func:`compute_metrics`):

* ``compute_stock_metrics_for_code`` — recompute exactly one code's
  metrics block. Called from NestJS's ``KlineWorker.process`` right
  after every per-code kline sync. Returns the freshly computed row;
  NestJS persists it via the local ``LocalStockMetaWriterService``.
* ``compute_stock_metrics_for_codes`` — batched variant. Returns the
  whole batch in one Arrow table so the NestJS writer can rewrite
  ``stock_metas.parquet`` once for many codes (cold-start backfill).
  Empty ``codes`` means "every code the meta repo knows about".

Storage-unify (storage-unify-rollout.md): Python is read-only for
``stock_metas.parquet`` — the previous ``upsert_stock_metrics_for_*``
ops persisted directly here, which left two processes racing on the
same file. The compute ops now return rows; the writer lives in
NestJS's stock-meta module.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_cache.kline_schema import daily_bar_from_row
from quant_core.domain.pure.compute_metrics import StockMetrics, compute_metrics
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.domain.types.kline import DailyBar
    from quant_core.ports.kline_repo import KlineRepo
    from quant_core.ports.stock_meta_repo import StockMetaRepo


_OP: Final[str] = "compute_stock_metrics_for_code"
_BATCH_OP: Final[str] = "compute_stock_metrics_for_codes"

# Mirrors the persisted block on ``stock_meta`` so NestJS can patch the
# meta parquet directly from this payload — no second mapping table.
COMPUTE_METRICS_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("asof", pa.date32()),
        # Decimals are serialised as strings (same convention as
        # ``stock_meta_schema``) so they round-trip without float drift.
        ("metrics_price", pa.string()),
        ("ret_1d", pa.string()),
        ("ret_5d", pa.string()),
        ("ret_10d", pa.string()),
        ("ret_20d", pa.string()),
        ("ret_90d", pa.string()),
        ("ret_250d", pa.string()),
        ("mkt_cap", pa.string()),
        ("float_mkt_cap", pa.string()),
        ("pe_ttm", pa.string()),
        ("pe_dynamic", pa.string()),
        ("pb", pa.string()),
        ("peg", pa.string()),
        ("gross_margin_ttm", pa.string()),
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


class ComputeStockMetricsForCodeHandler:
    """``compute_stock_metrics_for_code`` — return one code's metrics row.

    Empty table when the meta repo has no row for ``code`` (matches the
    behaviour callers depended on from the previous upsert handler: a
    silent skip for a brief window between a new listing and the next
    meta-sync cron tick).
    """

    op = _OP
    schema = COMPUTE_METRICS_SCHEMA

    __slots__ = ("_kline_repo", "_meta_repo")

    def __init__(
        self,
        meta_repo: StockMetaRepo,
        kline_repo: KlineRepo,
    ) -> None:
        self._meta_repo = meta_repo
        self._kline_repo = kline_repo

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        code = _require_code(args)
        meta = self._meta_repo.get(code)
        if meta is None:
            return COMPUTE_METRICS_SCHEMA.empty_table()
        bars = _bars_for_code(self._kline_repo, code)
        metrics = compute_metrics(meta, bars)
        return pa.Table.from_pylist([_row(metrics)], schema=COMPUTE_METRICS_SCHEMA)


class ComputeStockMetricsForCodesHandler:
    """``compute_stock_metrics_for_codes`` — batched projector.

    One Arrow row per code, in input order. Codes missing from the meta
    repo are silently dropped. Codes whose kline cache is empty still
    get a row written with ``asof = None`` so the persisted block
    reflects the "no bars yet" state once NestJS writes it back.
    """

    op = _BATCH_OP
    schema = COMPUTE_METRICS_SCHEMA

    __slots__ = ("_kline_repo", "_meta_repo")

    def __init__(
        self,
        meta_repo: StockMetaRepo,
        kline_repo: KlineRepo,
    ) -> None:
        self._meta_repo = meta_repo
        self._kline_repo = kline_repo

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        codes = _optional_code_list(args, "codes")
        metas = self._meta_repo.list_all() if not codes else self._meta_repo.get_many(codes)
        if not metas:
            return COMPUTE_METRICS_SCHEMA.empty_table()
        rows: list[dict[str, object]] = []
        for meta in metas:
            bars = _bars_for_code(self._kline_repo, meta.code)
            metrics = compute_metrics(meta, bars)
            rows.append(_row(metrics))
        return pa.Table.from_pylist(rows, schema=COMPUTE_METRICS_SCHEMA)


def _bars_for_code(kline_repo: KlineRepo, code: str) -> list[DailyBar]:
    """Read the trailing 400-calendar-day window for one code.

    Same window used by both handlers so the cost model stays identical
    (one ``get_range`` per code).
    """
    last_date = kline_repo.last_trade_date(code)
    if last_date is None:
        return []
    start = last_date - timedelta(days=400)
    table = kline_repo.get_range(code, start, last_date)
    return [daily_bar_from_row(r) for r in table.to_pylist()]


def _row(m: StockMetrics) -> dict[str, object]:
    return {
        "code": m.code,
        "asof": m.asof,
        "metrics_price": _dec(m.price),
        "ret_1d": _dec(m.ret_1d),
        "ret_5d": _dec(m.ret_5d),
        "ret_10d": _dec(m.ret_10d),
        "ret_20d": _dec(m.ret_20d),
        "ret_90d": _dec(m.ret_90d),
        "ret_250d": _dec(m.ret_250d),
        "mkt_cap": _dec(m.mkt_cap),
        "float_mkt_cap": _dec(m.float_mkt_cap),
        "pe_ttm": _dec(m.pe_ttm),
        "pe_dynamic": _dec(m.pe_dynamic),
        "pb": _dec(m.pb),
        "peg": _dec(m.peg),
        "gross_margin_ttm": _dec(m.gross_margin_ttm),
    }


def _dec(value: object) -> str | None:
    if value is None:
        return None
    return str(value)
