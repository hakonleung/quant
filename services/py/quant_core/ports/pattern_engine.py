"""``PatternEngine`` domain port (modules/04-pattern-matching.md §5)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from quant_core.domain.types.pattern import PatternMatch, PatternQuery


@runtime_checkable
class PatternEngine(Protocol):
    """Find the Top-N most similar windows to ``query.reference``."""

    def find_similar(self, query: PatternQuery) -> list[PatternMatch]: ...
