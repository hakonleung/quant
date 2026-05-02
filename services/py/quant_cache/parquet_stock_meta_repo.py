"""Parquet-backed :class:`StockMetaRepo`.

Thin business adapter: delegates storage to the generic
:class:`ParquetRecordRepo[StockMeta]` and translates the business-flavoured
``list_by_industry`` / ``get_many`` calls into ``QuerySpec`` queries on the
underlying repo.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from quant_core.domain.types.query import Eq, QuerySpec

from quant_cache.parquet_record_repo import ParquetRecordRepo
from quant_cache.stock_meta_schema import (
    STOCK_META_CODEC,
    STOCK_META_KEY_FIELD,
    STOCK_META_SCHEMA,
)

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence
    from pathlib import Path

    from quant_core.domain.types.stock import StockMeta


class ParquetStockMetaRepo:
    """Single-file parquet implementation of :class:`StockMetaRepo`."""

    __slots__ = ("_repo",)

    def __init__(self, path: Path) -> None:
        self._repo: ParquetRecordRepo[StockMeta] = ParquetRecordRepo(
            path,
            schema=STOCK_META_SCHEMA,
            key_field=STOCK_META_KEY_FIELD,
            codec=STOCK_META_CODEC,
        )

    # -- StockMetaRepo --------------------------------------------------

    def upsert_many(self, items: Iterable[StockMeta]) -> None:
        self._repo.upsert_many(items)

    def get(self, code: str) -> StockMeta | None:
        return self._repo.get(code)

    def get_many(self, codes: Sequence[str]) -> list[StockMeta]:
        # Per-key lookup keeps input ordering and skips missing codes,
        # which matches the port contract exactly. The dataset is
        # bounded (~5k stocks) so a per-row read is fine.
        out: list[StockMeta] = []
        for code in codes:
            item = self._repo.get(code)
            if item is not None:
                out.append(item)
        return out

    def list_by_industry(self, sw_l2: str) -> list[StockMeta]:
        spec = QuerySpec(
            where=Eq("industry_sw_l2", sw_l2),
            order_by=(("code", "asc"),),
        )
        return list(self._repo.query(spec))

    def list_all(self) -> list[StockMeta]:
        spec = QuerySpec(order_by=(("code", "asc"),))
        return list(self._repo.query(spec))
