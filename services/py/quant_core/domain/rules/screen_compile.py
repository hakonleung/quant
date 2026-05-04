"""Walk a screening AST to collect required columns + max lookback.

Pure: a single tree walk. The output drives the column-projection /
window-shrinkage step described in RFC 0001 §7 and module 03 §7.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from quant_core.domain.types.screen import (
    Aggregate,
    Compare,
    Consecutive,
    Const,
    Exists,
    Field,
    ForAll,
    Logical,
    PeriodReturn,
    Scale,
)

if TYPE_CHECKING:
    from quant_core.domain.types.screen import Predicate, Scalar


@dataclass(frozen=True, slots=True)
class CompileSummary:
    columns: frozenset[str]
    """Set of K-line column names the predicate touches."""
    lookback_days: int
    """Maximum days of history the predicate needs prior to (and incl.) ``asof``.

    1 means "only the asof bar"; ``ForAll(days=5)`` means we need the
    5 trailing bars (so ``lookback_days=5``); ``PeriodReturn(days=20)``
    needs ``asof`` + the 20th-prior bar (so 21 bars / lookback 21).
    """


def summarise(predicate: Predicate) -> CompileSummary:
    cols: set[str] = set()
    lookback = _walk(predicate, cols)
    return CompileSummary(columns=frozenset(cols), lookback_days=max(lookback, 1))


def _walk(node: Predicate, cols: set[str]) -> int:
    if isinstance(node, Compare):
        return max(_scalar(node.left, cols), _scalar(node.right, cols))
    if isinstance(node, Logical):
        return max((_walk(a, cols) for a in node.args), default=1)
    if isinstance(node, ForAll):
        return max(node.days, _walk(node.predicate, cols))
    if isinstance(node, Exists):
        return max(node.days, _walk(node.predicate, cols))
    if isinstance(node, Consecutive):
        # Consecutive scans the whole stored window for the longest run;
        # we use the predicate's own lookback as a lower bound. Callers
        # can widen the window via the universe-slice start if they want
        # extra context.
        return _walk(node.predicate, cols)
    raise AssertionError(f"unreachable Predicate node: {type(node).__name__}")


def _scalar(node: Scalar, cols: set[str]) -> int:
    if isinstance(node, Field):
        cols.add(node.field)
        return 1
    if isinstance(node, Const):
        return 1
    if isinstance(node, Aggregate):
        cols.add(node.field)
        return node.days
    if isinstance(node, PeriodReturn):
        cols.add("close_qfq")
        return node.days + 1  # need asof and (asof - days)
    if isinstance(node, Scale):
        return _scalar(node.inner, cols)
    raise AssertionError(f"unreachable Scalar node: {type(node).__name__}")
