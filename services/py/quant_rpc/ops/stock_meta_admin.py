"""Admin Flight ops for stock metadata.

Three ops:

* ``check_stock_meta_sources`` — runs ``healthcheck`` on every source in
  the chain and returns one Arrow row per source.
* ``sync_stock_meta_full`` — runs the full source → diff and returns the
  added-plus-changed meta rows in :data:`STOCK_META_SCHEMA`, with the
  diff counts encoded in the schema metadata. **Does not persist** —
  NestJS's ``LocalStockMetaWriterService`` writes them.
* ``enrich_stock_meta_for_code`` — single-code companion to the full
  sync. Returns 0 or 1 row in :data:`STOCK_META_SCHEMA`.

Storage-unify-rollout: storage is NestJS-owned end-to-end on the meta
parquet. Python only fetches + diffs.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_cache.stock_meta_schema import STOCK_META_SCHEMA, stock_meta_to_row
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.domain.types.stock import StockMeta
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
    """``sync_stock_meta_full`` — pull from sources, diff against local repo.

    Returns the added-plus-changed rows; diff counts ride along as
    schema metadata so NestJS can log them without a second op.
    """

    op = _SYNC_OP
    schema = STOCK_META_SCHEMA

    __slots__ = ("_sync",)

    def __init__(self, sync: StockMetaSyncService) -> None:
        self._sync = sync

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        del args
        report = self._sync.run_full_sync()
        metadata = {
            b"source": report.source.encode("utf-8"),
            b"fetched": str(report.fetched).encode("ascii"),
            b"added": str(report.added).encode("ascii"),
            b"changed": str(report.changed).encode("ascii"),
            b"unchanged": str(report.unchanged).encode("ascii"),
        }
        schema = STOCK_META_SCHEMA.with_metadata(metadata)
        if not report.upserts:
            return schema.empty_table()
        return _metas_to_table(report.upserts, schema)


class EnrichOneHandler:
    """``enrich_stock_meta_for_code`` — pull one stock's full meta.

    Single-code companion to :class:`SyncFullHandler`; powers the
    NestJS orchestration's per-code enrich queue. 0 or 1 row.
    """

    op = _ENRICH_OP
    schema = STOCK_META_SCHEMA

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
        if item is None:
            return STOCK_META_SCHEMA.empty_table()
        return _metas_to_table([item], STOCK_META_SCHEMA)


def _metas_to_table(items: list[StockMeta] | tuple[StockMeta, ...], schema: pa.Schema) -> pa.Table:
    return pa.Table.from_pylist([stock_meta_to_row(item) for item in items], schema=schema)
