"""Flight ops for K-line caching (modules/02-stock-kline.md §6 +
modules/09-update-orchestration.md §6.2).

* ``sync_kline_for_code`` — args ``{"code": "600519"[, "list_date": "YYYY-MM-DD"]}``;
  delegates to :class:`KlineService.sync_code` and returns a one-row
  report describing the action taken.
* ``list_kline_watermarks`` — no args; returns one row per stock-meta
  code with its current K-line watermark (``last_date`` is null when no
  bars are stored yet). Powers the cron inspector that decides which
  codes need a sync this tick.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.ports.kline_repo import KlineRepo
    from quant_core.ports.stock_meta_repo import StockMetaRepo
    from quant_core.services.kline_service import KlineService


_SYNC_OP: Final[str] = "sync_kline_for_code"
_WATERMARKS_OP: Final[str] = "list_kline_watermarks"


SYNC_REPORT_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("mode", pa.string()),
        ("fetched_bars", pa.int64()),
        ("written_bars", pa.int64()),
        ("new_last_date", pa.date32()),
    ]
)


WATERMARKS_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("last_date", pa.date32()),
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
    """``sync_kline_for_code`` — incremental or recompute sync for one code."""

    op = _SYNC_OP
    schema = SYNC_REPORT_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: KlineService) -> None:
        self._service = service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        code = _require_str(args, "code")
        list_date = _optional_iso_date(args, "list_date")
        trace_raw = args.get("trace_id")
        trace_id = trace_raw if isinstance(trace_raw, str) and trace_raw else None
        report = self._service.sync_code(code, list_date=list_date, trace_id=trace_id)
        return pa.Table.from_pylist(
            [
                {
                    "code": report.code,
                    "mode": report.mode,
                    "fetched_bars": report.fetched_bars,
                    "written_bars": report.written_bars,
                    "new_last_date": report.new_last_date,
                }
            ],
            schema=SYNC_REPORT_SCHEMA,
        )


class ListKlineWatermarksHandler:
    """``list_kline_watermarks`` — every stock-meta code + its kline watermark.

    ``last_date`` is ``null`` for codes whose K-line cache is still empty.
    The orchestrator treats those as "stale, sync me first".
    """

    op = _WATERMARKS_OP
    schema = WATERMARKS_SCHEMA

    __slots__ = ("_meta_repo", "_repo")

    def __init__(self, meta_repo: StockMetaRepo, repo: KlineRepo) -> None:
        self._meta_repo = meta_repo
        self._repo = repo

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        del args
        rows: list[dict[str, object]] = []
        for meta in self._meta_repo.list_all():
            last = self._repo.last_trade_date(meta.code)
            rows.append({"code": meta.code, "last_date": last})
        if not rows:
            return WATERMARKS_SCHEMA.empty_table()
        return pa.Table.from_pylist(rows, schema=WATERMARKS_SCHEMA)
