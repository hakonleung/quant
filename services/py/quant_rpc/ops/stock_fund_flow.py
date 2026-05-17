"""Flight op for DDE 主力 fund-flow ranks (modules/01-stock-meta.md §5).

``list_stock_fund_flow_ranks`` — args ``{}`` or ``{"windows": [3, 5, ...]}``;
returns one row per code carrying the trailing-N-day 主力净流入 amount
for each requested window (default: every window in
:data:`DDE_WINDOWS`). Amounts are encoded as decimal strings — Parquet
storage downstream is string-typed, and Arrow Decimal128 with a single
schema-wide scale can't hold "tens of millions of CNY" and
"sub-fractional ratios" together.

NestJS owns the persistence side: this op only fetches + joins. The
NestJS sync service then joins on local kline ``amount`` sums to derive
the `dde_main_inflow_ratio_Nd` columns and writes the merged block via
``LocalStockMetaWriterService.upsertFundFlow``.

Codes that returned numeric data for at least one window are emitted;
codes for which every window came back ``--`` are dropped (a row of
all-null would survive nothing downstream).
"""

from __future__ import annotations

import logging
import time
from decimal import Decimal
from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_core.domain.types.fund_flow import DDE_WINDOWS
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from quant_io.sources.akshare_stock_fund_flow import AKShareFundFlowRankSource


_OP: Final[str] = "list_stock_fund_flow_ranks"
_logger = logging.getLogger(__name__)


def _build_schema(windows: Iterable[int]) -> pa.Schema:
    fields: list[pa.Field] = [pa.field("code", pa.string(), nullable=False)]
    for w in windows:
        fields.append(pa.field(f"main_net_inflow_{w}d", pa.string()))
    return pa.schema(fields)


STOCK_FUND_FLOW_RANK_SCHEMA: Final[pa.Schema] = _build_schema(DDE_WINDOWS)
"""Default schema (every window in :data:`DDE_WINDOWS`)."""


class ListStockFundFlowRanksHandler:
    """``list_stock_fund_flow_ranks`` — full-market rank for each window."""

    op = _OP
    schema = STOCK_FUND_FLOW_RANK_SCHEMA

    __slots__ = ("_source",)

    def __init__(self, source: AKShareFundFlowRankSource) -> None:
        self._source = source

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        windows = _parse_windows(args.get("windows"))
        schema = _build_schema(windows)
        per_window: dict[int, dict[str, Decimal | None]] = {}
        for w in windows:
            t0 = time.monotonic()
            per_window[w] = self._source.fetch_rank(w)
            _logger.info(
                "fund_flow_window_fetched window=%d rows=%d elapsed_ms=%d",
                w,
                len(per_window[w]),
                int((time.monotonic() - t0) * 1000),
            )
        codes: set[str] = set()
        for table in per_window.values():
            codes.update(table.keys())
        if not codes:
            return schema.empty_table()
        rows: list[dict[str, object]] = []
        for code in sorted(codes):
            row: dict[str, object] = {"code": code}
            any_value = False
            for w in windows:
                value = per_window[w].get(code)
                if value is not None:
                    any_value = True
                row[f"main_net_inflow_{w}d"] = None if value is None else str(value)
            if any_value:
                rows.append(row)
        if not rows:
            return schema.empty_table()
        return pa.Table.from_pylist(rows, schema=schema)


def _parse_windows(value: object) -> tuple[int, ...]:
    """Default to :data:`DDE_WINDOWS`; validate explicit overrides."""
    if value is None:
        return DDE_WINDOWS
    if not isinstance(value, list):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"windows must be a list of ints, got {type(value).__name__}",
        )
    out: list[int] = []
    seen: set[int] = set()
    for raw in value:
        if not isinstance(raw, int) or isinstance(raw, bool):
            raise QuantError(
                "INVALID_ARGUMENT",
                f"windows entries must be ints, got {raw!r}",
            )
        if raw not in DDE_WINDOWS:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"unsupported DDE window {raw!r}; expected one of {sorted(DDE_WINDOWS)}",
            )
        if raw in seen:
            continue
        seen.add(raw)
        out.append(raw)
    if not out:
        raise QuantError("INVALID_ARGUMENT", "windows must be non-empty")
    return tuple(out)
