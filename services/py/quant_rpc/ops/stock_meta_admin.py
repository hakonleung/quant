"""Admin Flight ops for stock metadata.

Two ops:

* ``check_stock_meta_sources`` — runs ``healthcheck`` on every source in
  the chain and returns one Arrow row per source.
* ``sync_stock_meta_full`` — runs the full source → repo sync and returns
  a single-row table with the result counts.

Both ops take no args (the chain composition is fixed at server start).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import pyarrow as pa

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.services.stock_meta_sync_service import StockMetaSyncService


_CHECK_OP: Final[str] = "check_stock_meta_sources"
_SYNC_OP: Final[str] = "sync_stock_meta_full"


SOURCE_HEALTH_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("name", pa.string()),
        ("available", pa.bool_()),
        ("latency_ms", pa.int64()),
        ("quota_remaining", pa.int64()),
        ("last_error", pa.string()),
    ]
)

SYNC_REPORT_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("source", pa.string()),
        ("fetched", pa.int64()),
        ("added", pa.int64()),
        ("changed", pa.int64()),
        ("unchanged", pa.int64()),
    ]
)


class CheckSourcesHandler:
    """``check_stock_meta_sources`` — per-source healthcheck."""

    op = _CHECK_OP
    schema = SOURCE_HEALTH_SCHEMA

    __slots__ = ("_sync",)

    def __init__(self, sync: StockMetaSyncService) -> None:
        self._sync = sync

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        del args
        healths = self._sync.healthcheck_sources()
        rows = [
            {
                "name": h.name,
                "available": h.available,
                "latency_ms": h.latency_ms if h.latency_ms is not None else -1,
                "quota_remaining": h.quota_remaining if h.quota_remaining is not None else -1,
                "last_error": h.last_error or "",
            }
            for h in healths
        ]
        if not rows:
            return SOURCE_HEALTH_SCHEMA.empty_table()
        return pa.Table.from_pylist(rows, schema=SOURCE_HEALTH_SCHEMA)


class SyncFullHandler:
    """``sync_stock_meta_full`` — pull from sources, upsert into local repo."""

    op = _SYNC_OP
    schema = SYNC_REPORT_SCHEMA

    __slots__ = ("_sync",)

    def __init__(self, sync: StockMetaSyncService) -> None:
        self._sync = sync

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        del args
        report = self._sync.run_full_sync()
        return pa.Table.from_pylist(
            [
                {
                    "source": report.source,
                    "fetched": report.fetched,
                    "added": report.added,
                    "changed": report.changed,
                    "unchanged": report.unchanged,
                }
            ],
            schema=SYNC_REPORT_SCHEMA,
        )
