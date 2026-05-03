"""Universe-screen DSL — filters that run on :class:`StockMeta` rows.

This is a separate AST from the K-line :mod:`quant_core.domain.types.screen`
DSL because the data shape is different (point-in-time meta vs. time
series) and the available fields are disjoint.

A universe filter is the **first** stage of a screening pipeline: it
prunes the candidate codes (drop ST, drop 北交所, etc.) before the
heavyweight K-line predicate runs. Keeping it standalone means:

* No accidental field-name collision with the K-line DSL.
* Cheap evaluation: no IO, no Polars, plain dataclass walks.
* Clear LLM contract: each stage gets its own prompt and validator.

Hardcoded fields (closed set):

* ``code``         — bare 6-digit string
* ``name``         — display name
* ``industries``   — comma-joined industry tags
* ``list_date``    — IPO date
* ``float_pct``    — float / total share ratio (Decimal)
* ``is_st``        — derived: ``name`` starts with ``ST`` or ``*ST``
* ``exchange``     — derived: ``"sh"`` / ``"sz"`` / ``"bj"`` from code prefix
* ``listed_days``  — derived: ``asof - list_date`` in days
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

if TYPE_CHECKING:
    from datetime import date
    from decimal import Decimal


UNIVERSE_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "code",
        "name",
        "industries",
        "list_date",
        "float_pct",
        "is_st",
        "exchange",
        "listed_days",
    }
)

UniverseCompareOp = Literal[
    "gt", "lt", "gte", "lte", "eq", "neq", "contains", "starts_with", "not_starts_with"
]
UniverseLogicalOp = Literal["and", "or", "not"]


@dataclass(frozen=True, slots=True)
class UniverseField:
    field: str  # one of UNIVERSE_FIELDS


# Const value carries a tag so the evaluator can check left/right type
# alignment without reflection.
@dataclass(frozen=True, slots=True)
class UniverseConst:
    value: str | int | bool | Decimal | date


@dataclass(frozen=True, slots=True)
class UniverseCompare:
    op: UniverseCompareOp
    left: UniverseField
    right: UniverseConst


@dataclass(frozen=True, slots=True)
class UniverseLogical:
    op: UniverseLogicalOp
    args: tuple[UniverseExpr, ...]


UniverseExpr = UniverseCompare | UniverseLogical


@dataclass(frozen=True, slots=True)
class UniversePlan:
    """A single universe filter stage."""

    asof: date
    """Point-in-time used for ``listed_days`` derivation."""
    expr: UniverseExpr
