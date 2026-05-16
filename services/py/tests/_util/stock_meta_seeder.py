"""Test helper: write a ``stock_metas.parquet`` from ``StockMeta`` items.

Replaces the old ``ParquetStockMetaRepo.upsert_many`` seed path now that
production Python has no write API for the meta parquet
(storage-unify-rollout). Uses the same codec the read path consumes so
the round-trip is identical to what NestJS's writer produces.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pyarrow as pa
import pyarrow.parquet as pq
from quant_cache.stock_meta_schema import STOCK_META_SCHEMA, stock_meta_to_row

if TYPE_CHECKING:
    from collections.abc import Iterable
    from pathlib import Path

    from quant_core.domain.types.stock import StockMeta


def seed_stock_meta_parquet(path: Path, items: Iterable[StockMeta]) -> None:
    """Write ``items`` to ``path`` as a fresh ``stock_metas.parquet``.

    Overwrites any existing file. Designed to be cheap and synchronous;
    tests should call this once per fixture rather than in a hot loop.
    """
    rows = [stock_meta_to_row(item) for item in items]
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        pq.write_table(STOCK_META_SCHEMA.empty_table(), path)
        return
    table = pa.Table.from_pylist(rows, schema=STOCK_META_SCHEMA)
    pq.write_table(table, path)
