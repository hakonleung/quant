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
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.services.stock_meta_sync_service import StockMetaSyncService


_CHECK_OP: Final[str] = "check_stock_meta_sources"
_SYNC_OP: Final[str] = "sync_stock_meta_full"
_ENRICH_OP: Final[str] = "enrich_stock_meta_for_code"


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


ENRICH_REPORT_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("found", pa.bool_()),
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


class EnrichOneHandler:
    """``enrich_stock_meta_for_code`` — pull one stock's full meta + upsert.

    Single-code companion to :class:`SyncFullHandler`; powers the
    NestJS orchestration's per-code enrich queue
    (`docs/modules/09-update-orchestration.md` §6.1).
    """

    op = _ENRICH_OP
    schema = ENRICH_REPORT_SCHEMA

    __slots__ = ("_sync",)

    def __init__(self, sync: StockMetaSyncService) -> None:
        self._sync = sync

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        raw_code = args.get("code")
        if not isinstance(raw_code, str) or not raw_code:
            raise QuantError(
                "INVALID_ARGUMENT",
                "args.code must be a non-empty string",
                {"key": "code"},
            )
        item = self._sync.enrich_one(raw_code)
        return pa.Table.from_pylist(
            [{"code": raw_code, "found": item is not None}],
            schema=ENRICH_REPORT_SCHEMA,
        )
