"""End-to-end screening pipeline (universe → kline → rank → top-N).

A thin composer over the two standalone services so callers don't have
to plumb the steps themselves. Each stage stays independent — the
pipeline is the integration point, not the abstraction.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

    from quant_core.domain.types.screen import RankSpec, ScreenPlan, ScreenResult
    from quant_core.domain.types.universe_screen import UniversePlan
    from quant_core.services.screen_service import ScreenService
    from quant_core.services.universe_screen_service import UniverseScreenService


@dataclass(frozen=True, slots=True)
class PipelineRequest:
    """Inputs to a one-shot screening run.

    Attributes:
        screen_plan: The K-line predicate plan (mandatory).
        universe_plan: Optional pre-filter on StockMeta. When ``None``,
            the pipeline runs on every code in the meta cache.
        explicit_universe: Optional override that bypasses both meta
            lookup and ``universe_plan``. Useful when the caller already
            has a curated list (admin tooling, tests).
        rank: Optional ranking + top-N on the matched results.
    """

    screen_plan: ScreenPlan
    universe_plan: UniversePlan | None = None
    explicit_universe: Sequence[str] | None = None
    rank: RankSpec | None = None


class ScreeningPipeline:
    """Compose universe filter, K-line screen, and rank-N into one call."""

    __slots__ = ("_screen", "_universe")

    def __init__(
        self,
        universe_service: UniverseScreenService,
        screen_service: ScreenService,
    ) -> None:
        self._universe = universe_service
        self._screen = screen_service

    def run(self, request: PipelineRequest) -> ScreenResult:
        """Resolve universe → run plan → rank → return result."""
        universe = self._resolve_universe(request)
        return self._screen.execute(request.screen_plan, universe, rank=request.rank)

    # -- internals ------------------------------------------------------

    def _resolve_universe(self, request: PipelineRequest) -> list[str]:
        if request.explicit_universe is not None:
            return list(request.explicit_universe)
        if request.universe_plan is not None:
            return self._universe.filter_codes(request.universe_plan)
        # No filter and no override → caller wants the entire cached
        # universe. Pull every meta and use its code.
        return self._universe.filter_codes(_match_all_plan(request))


def _match_all_plan(request: PipelineRequest) -> UniversePlan:
    """Build a trivial "always-true" UniversePlan keyed by the screen asof.

    Equivalent to ``code != ""``: the universe service still needs an
    AST and the cached meta list to materialise codes.
    """
    from quant_core.domain.types.universe_screen import (
        UniverseCompare,
        UniverseConst,
        UniverseField,
        UniversePlan,
    )

    return UniversePlan(
        asof=request.screen_plan.asof,
        expr=UniverseCompare(
            op="neq",
            left=UniverseField(field="code"),
            right=UniverseConst(value=""),
        ),
    )
