"""``StockMetaRepo`` domain port (modules/01-stock-meta.md §3).

Business interface for stock-metadata persistence. Sits on top of the
generic :class:`quant_core.ports.cache.RecordRepo`; the Parquet
implementation lives in :mod:`quant_cache.parquet_stock_meta_repo`.

Search-by-name (with pinyin support) is intentionally **not** in this
milestone — it requires a name-index strategy and pinyin tokenizer. It
will land alongside the search controller in a later F1.x.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

    from quant_core.domain.types.stock import StockMeta


@runtime_checkable
class StockMetaRepo(Protocol):
    """Persistence port for :class:`StockMeta`."""

    def upsert_many(self, items: Iterable[StockMeta]) -> None:
        """Insert-or-replace by ``code``."""
        ...

    def get(self, code: str) -> StockMeta | None:
        """Return the meta for ``code`` or ``None``."""
        ...

    def get_many(self, codes: Sequence[str]) -> list[StockMeta]:
        """Return metas in input order; missing codes are dropped silently.

        Caller can detect omissions by length comparison; callers that
        need an "exists" guarantee should use :meth:`get` per code.
        """
        ...

    def list_by_industry(self, sw_l2: str) -> list[StockMeta]:
        """Return all stocks in the given Shenwan L2 industry, sorted by code."""
        ...
