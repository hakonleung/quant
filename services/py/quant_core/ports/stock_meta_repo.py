"""``StockMetaRepo`` domain port (modules/01-stock-meta.md §3).

Read-only business interface for stock-metadata persistence. The
Parquet implementation lives in
:mod:`quant_cache.parquet_stock_meta_repo`. Storage-unify-rollout:
writes to ``data/stock_metas.parquet`` are NestJS-only (see
``apps/api/src/modules/stock-meta/local-stock-meta-writer.service.ts``);
Python services consume the file but never mutate it.

Search-by-name (with pinyin support) is intentionally **not** in this
milestone — it requires a name-index strategy and pinyin tokenizer. It
will land alongside the search controller in a later F1.x.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from collections.abc import Sequence

    from quant_core.domain.types.stock import StockMeta


@runtime_checkable
class StockMetaRepo(Protocol):
    """Read-only persistence port for :class:`StockMeta`."""

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

    def list_all(self) -> list[StockMeta]:
        """Return every stored stock, sorted by code.

        Bounded dataset (~5k rows for A-share); callers can iterate without
        pagination. Used by the front-end's universe pickers and by the
        admin sync workflow's "diff against current" step.
        """
        ...
