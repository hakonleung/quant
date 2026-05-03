"""Universe-screen orchestration.

Wraps :func:`evaluate_universe` with the meta repo so callers get a
clean "give me the codes that pass this filter" handle.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from quant_core.domain.rules.universe_eval import evaluate_universe

if TYPE_CHECKING:
    from quant_core.domain.types.stock import StockMeta
    from quant_core.domain.types.universe_screen import UniversePlan
    from quant_core.ports.stock_meta_repo import StockMetaRepo


class UniverseScreenService:
    """Filter the local stock-meta cache against a :class:`UniversePlan`."""

    __slots__ = ("_meta_repo",)

    def __init__(self, meta_repo: StockMetaRepo) -> None:
        self._meta_repo = meta_repo

    def filter_codes(self, plan: UniversePlan) -> list[str]:
        """Return codes (sorted asc) whose StockMeta satisfies ``plan``."""
        return [m.code for m in self.filter_metas(plan)]

    def filter_metas(self, plan: UniversePlan) -> list[StockMeta]:
        """Return :class:`StockMeta` rows that satisfy ``plan``."""
        all_metas = self._meta_repo.list_all()
        return evaluate_universe(plan, all_metas)
