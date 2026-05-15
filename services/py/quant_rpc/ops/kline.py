"""Flight ops for K-line caching (modules/02-stock-kline.md §6 +
modules/09-update-orchestration.md §6.2).

* ``sync_kline_for_code`` — args ``{"code": "600519"[, "list_date": "YYYY-MM-DD"]}``;
  delegates to :class:`KlineService.sync_code` and returns the assembled
  bars as an Arrow table matching the NestJS-side ``KLINE_COLUMNS``
  schema. Mode (``backfill`` / ``incremental`` / ``recompute`` / ``skip``)
  and bar counts ride along in the schema metadata for orchestrator
  logging. The handler keeps writing to the Python-local cache so the
  in-process screen / pattern / blacklist services that still read via
  :class:`KlineRepo` keep working; NestJS now owns the canonical store
  via :class:`KlineWriterService` (plan §3.3 — Phase 2 write flip).

The read-side ops (``list_kline_for_code`` / ``list_kline_bulk_last_n`` /
``list_kline_watermarks``) were retired once NestJS started serving
kline reads from its own ``DuckDBParquetTimeSeriesStore``; the
orchestrator gets watermarks directly from ``KlineReaderService``.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.domain.types.kline import DailyBar
    from quant_core.services.kline_service import KlineService


_SYNC_OP: Final[str] = "sync_kline_for_code"


# Matches NestJS apps/api/src/modules/kline/kline.row.ts:KLINE_COLUMNS so
# the worker can convert rows 1:1 without an intermediate schema. Decimals
# downcast to float64 — kline precision needs are well inside double range
# (max ~5 significant digits for prices, exact integers for volume).
SYNC_BARS_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("ts", pa.date32()),
        ("open_qfq", pa.float64()),
        ("high_qfq", pa.float64()),
        ("low_qfq", pa.float64()),
        ("close_qfq", pa.float64()),
        ("volume", pa.int64()),
        ("amount", pa.float64()),
        ("turnover_rate", pa.float64()),
        ("ma5", pa.float64()),
        ("ma10", pa.float64()),
        ("ma20", pa.float64()),
        ("ma60", pa.float64()),
    ]
)


def _require_str(args: Mapping[str, object], key: str) -> str:
    raw = args.get(key)
    if not isinstance(raw, str) or not raw:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a non-empty string",
            {"key": key},
        )
    return raw


def _optional_iso_date(args: Mapping[str, object], key: str) -> date | None:
    raw = args.get(key)
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be an ISO-8601 date string",
            {"key": key, "got": type(raw).__name__},
        )
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} is not a valid ISO date",
            {"key": key, "value": raw},
        ) from exc


class SyncKlineForCodeHandler:
    """``sync_kline_for_code`` — incremental or recompute sync for one code.

    Returns the assembled bars in :data:`SYNC_BARS_SCHEMA`, with the sync
    report (mode / fetched_bars / written_bars / new_last_date) attached
    as schema metadata. Empty table on a ``skip`` outcome.
    """

    op = _SYNC_OP
    schema = SYNC_BARS_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: KlineService) -> None:
        self._service = service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        code = _require_str(args, "code")
        list_date = _optional_iso_date(args, "list_date")
        trace_raw = args.get("trace_id")
        trace_id = trace_raw if isinstance(trace_raw, str) and trace_raw else None
        report, bars = self._service.sync_code(
            code, list_date=list_date, trace_id=trace_id
        )
        metadata = {
            b"mode": report.mode.encode("ascii"),
            b"fetched_bars": str(report.fetched_bars).encode("ascii"),
            b"written_bars": str(report.written_bars).encode("ascii"),
            b"new_last_date": (
                report.new_last_date.isoformat() if report.new_last_date else ""
            ).encode("ascii"),
            b"code": report.code.encode("ascii"),
        }
        schema = SYNC_BARS_SCHEMA.with_metadata(metadata)
        if not bars:
            return schema.empty_table()
        return pa.Table.from_pylist(
            [_bar_to_row(bar) for bar in bars],
            schema=schema,
        )


def _bar_to_row(bar: DailyBar) -> dict[str, object]:
    return {
        "code": bar.code,
        "ts": bar.trade_date,
        "open_qfq": float(bar.open_qfq),
        "high_qfq": float(bar.high_qfq),
        "low_qfq": float(bar.low_qfq),
        "close_qfq": float(bar.close_qfq),
        "volume": int(bar.volume),
        "amount": float(bar.amount),
        "turnover_rate": float(bar.turnover_rate),
        "ma5": _opt_float(bar.ma5),
        "ma10": _opt_float(bar.ma10),
        "ma20": _opt_float(bar.ma20),
        "ma60": _opt_float(bar.ma60),
    }


def _opt_float(v: Decimal | None) -> float | None:
    return float(v) if v is not None else None
