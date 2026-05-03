"""Screening DSL AST + result types (rfcs/0001-screening-dsl.md).

The AST is a closed family of frozen dataclasses; ``parse_predicate``
(in :mod:`quant_core.domain.rules.screen_parse`) builds it from raw
JSON-shaped dicts and rejects every malformed shape with
``DSL_INVALID``. The compiler / executor consumes only this typed shape.

v1 scope (RFC §13 narrows out cross-section / fundamentals):

* Logical: ``and`` / ``or`` / ``not``
* Compare: ``gt`` / ``lt`` / ``gte`` / ``lte`` / ``eq`` / ``neq``
* Window assertions: ``for_all`` / ``exists`` / ``consecutive``
* Scalars: ``Field`` / ``Aggregate`` (mean/sum/min/max/count) /
  ``PeriodReturn`` / ``Const``. ``Indicator`` is collapsed into
  ``Field("ma{period}")`` for the four standard windows; non-standard
  periods are deferred (RFC §4.3 calls it out as a 95% case).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal

if TYPE_CHECKING:
    from datetime import date
    from decimal import Decimal


# Closed set of column names callers may reference. Mirrors KLINE_SCHEMA.
FIELD_NAMES: Final[frozenset[str]] = frozenset(
    {
        "open",
        "high",
        "low",
        "close",
        "open_qfq",
        "high_qfq",
        "low_qfq",
        "close_qfq",
        "volume",
        "amount",
        "turnover_rate",
        "ma5",
        "ma10",
        "ma20",
        "ma60",
        "pct_chg_qfq",
    }
)

CompareOp = Literal["gt", "lt", "gte", "lte", "eq", "neq"]
LogicalOp = Literal["and", "or", "not"]
AggOp = Literal["mean", "sum", "min", "max", "count"]
SetOp = Literal["intersect", "union", "except"]


@dataclass(frozen=True, slots=True)
class Field:
    field: str  # one of FIELD_NAMES


@dataclass(frozen=True, slots=True)
class Const:
    value: Decimal


@dataclass(frozen=True, slots=True)
class Aggregate:
    agg: AggOp
    field: str
    days: int


@dataclass(frozen=True, slots=True)
class PeriodReturn:
    days: int


Scalar = Field | Const | Aggregate | PeriodReturn


@dataclass(frozen=True, slots=True)
class Compare:
    op: CompareOp
    left: Scalar
    right: Scalar


@dataclass(frozen=True, slots=True)
class Logical:
    op: LogicalOp
    args: tuple[Predicate, ...]


@dataclass(frozen=True, slots=True)
class ForAll:
    days: int
    predicate: Predicate


@dataclass(frozen=True, slots=True)
class Exists:
    days: int
    predicate: Predicate


@dataclass(frozen=True, slots=True)
class Consecutive:
    min_len: int
    predicate: Predicate


Predicate = Compare | Logical | ForAll | Exists | Consecutive


@dataclass(frozen=True, slots=True)
class ScreenPlan:
    asof: date
    expr: Predicate


@dataclass(frozen=True, slots=True)
class ScreenMatch:
    code: str
    evidence: dict[str, object]


@dataclass(frozen=True, slots=True)
class ScreenResult:
    asof: date
    plan_signature: str
    matches: tuple[ScreenMatch, ...]
