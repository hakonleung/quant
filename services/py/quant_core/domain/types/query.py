"""``QuerySpec`` — internal query AST consumed by ``RecordRepo`` adapters.

A deliberately tiny algebra over filtering / ordering / limiting. We do **not**
expose SQL or backend-specific predicates so that swapping a Parquet store for
a SQLite or Postgres store is a pure adapter change (CLAUDE.md §2.7,
docs/integrations/cache-abstraction.md §6).

Adapters are responsible for translating these nodes to the underlying engine
(``pyarrow`` filters, ``sqlite`` SQL, etc.) and **must** raise ``QuantError``
with code ``EVALUATION_FAILED`` for any node they cannot handle, not silently
fall back to a full scan.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final, Literal

# Concrete value types allowed in predicates. Decimals are passed as ``str`` to
# avoid float-rounding surprises across backends; adapters cast on read.
Primitive = str | int | float | bool | None
"""Primitive value types accepted in predicates."""

OrderDir = Literal["asc", "desc"]


@dataclass(frozen=True, slots=True)
class Eq:
    """``field == value``."""

    field: str
    value: Primitive


@dataclass(frozen=True, slots=True)
class In:
    """``field IN (...)``. Empty ``values`` matches nothing."""

    field: str
    values: tuple[Primitive, ...]


@dataclass(frozen=True, slots=True)
class Range:
    """``lo <= field <= hi``. Either bound may be ``None`` for unbounded."""

    field: str
    lo: Primitive
    hi: Primitive


@dataclass(frozen=True, slots=True)
class Like:
    """SQL ``LIKE`` semantics: ``%`` = any chars, ``_`` = single char."""

    field: str
    pattern: str


@dataclass(frozen=True, slots=True)
class And:
    """Conjunction. Empty ``parts`` is the always-true predicate."""

    parts: tuple[Predicate, ...]


@dataclass(frozen=True, slots=True)
class Or:
    """Disjunction. Empty ``parts`` is the always-false predicate."""

    parts: tuple[Predicate, ...]


Predicate = Eq | In | Range | Like | And | Or
"""Closed union of supported predicate nodes."""


@dataclass(frozen=True, slots=True)
class QuerySpec:
    """Filter + order + limit, all optional."""

    where: Predicate | None = None
    order_by: tuple[tuple[str, OrderDir], ...] = field(default_factory=tuple)
    limit: int | None = None


MATCH_ALL: Final[QuerySpec] = QuerySpec()
"""Convenience constant for "no filter, no limit"."""
