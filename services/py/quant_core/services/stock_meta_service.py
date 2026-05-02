"""Business orchestration for stock metadata (modules/01-stock-meta.md §6.1).

Translates between the domain port (:class:`StockMetaRepo`) and the upper
layers (Flight handlers, future HTTP). The service owns the
"missing code → typed error" rule so callers don't sprinkle `if x is None`
checks; it also owns batch-shape semantics (deduplicate, preserve order).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Sequence

    from quant_core.domain.types.stock import StockMeta
    from quant_core.ports.stock_meta_repo import StockMetaRepo


class StockMetaService:
    """High-level operations on stock metadata."""

    __slots__ = ("_repo",)

    def __init__(self, repo: StockMetaRepo) -> None:
        self._repo = repo

    def get(self, code: str) -> StockMeta:
        """Return the meta for ``code``.

        Raises:
            QuantError: code ``STOCK_NOT_FOUND`` if no such stock.
        """
        item = self._repo.get(code)
        if item is None:
            raise QuantError(
                "STOCK_NOT_FOUND",
                f"no such stock: {code}",
                {"code": code},
            )
        return item

    def get_batch(self, codes: Sequence[str]) -> list[StockMeta]:
        """Return metas for ``codes`` in input order.

        Duplicates in ``codes`` are de-duplicated (first occurrence wins);
        codes without a matching record are dropped silently. Callers
        that need an "all-or-nothing" guarantee should compare lengths.
        """
        seen: set[str] = set()
        ordered_unique: list[str] = []
        for code in codes:
            if code not in seen:
                seen.add(code)
                ordered_unique.append(code)
        return self._repo.get_many(ordered_unique)

    def list_by_industry(self, sw_l2: str) -> list[StockMeta]:
        """All stocks in the given Shenwan L2 industry, sorted by code."""
        if not sw_l2:
            raise QuantError(
                "INVALID_ARGUMENT",
                "sw_l2 must be non-empty",
            )
        return self._repo.list_by_industry(sw_l2)
