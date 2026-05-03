"""Evaluate a screening predicate against one stock's K-line slice.

Pure interpreter over a list of dict rows (one per trade_date, ordered
ascending). Adapters in the service layer materialise a Polars / Arrow
slice and pass the per-code rows here.

We keep this in the domain layer because it has zero IO and only
depends on :mod:`quant_core.domain.types.screen`. The simple
list-of-dict shape is intentional: it sidesteps Polars-version
sensitivity for the v1 cut. Performance is fine for the v1 budgets
(~5500 codes x ≤60 rows x ≤10 columns).
"""

from __future__ import annotations

from decimal import Decimal
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
)
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from quant_core.domain.types.screen import Predicate, Scalar


# Sentinel for "no value at this row" (e.g. ma60 on a fresh listing).
_NA = object()


def evaluate_predicate(rows: Sequence[Mapping[str, object]], pred: Predicate) -> bool:
    """Return True iff ``pred`` matches given the stock's window slice.

    ``rows`` is sorted ascending by trade_date. ``rows[-1]`` is the
    ``asof`` bar; earlier rows are the lookback context.
    """
    if not rows:
        return False
    return _eval_predicate(rows, pred)


def _eval_predicate(rows: Sequence[Mapping[str, object]], pred: Predicate) -> bool:
    if isinstance(pred, Compare):
        return _eval_compare(rows, pred)
    if isinstance(pred, Logical):
        return _eval_logical(rows, pred)
    if isinstance(pred, ForAll):
        return _eval_for_all(rows, pred)
    if isinstance(pred, Exists):
        return _eval_exists(rows, pred)
    if isinstance(pred, Consecutive):
        return _eval_consecutive(rows, pred)
    raise QuantError(
        "EVALUATION_FAILED",
        f"unhandled predicate node: {type(pred).__name__}",
    )


def _eval_logical(rows: Sequence[Mapping[str, object]], node: Logical) -> bool:
    if node.op == "not":
        return not _eval_predicate(rows, node.args[0])
    if node.op == "and":
        return all(_eval_predicate(rows, a) for a in node.args)
    return any(_eval_predicate(rows, a) for a in node.args)


def _eval_compare(rows: Sequence[Mapping[str, object]], node: Compare) -> bool:
    left = _eval_scalar(rows, node.left)
    right = _eval_scalar(rows, node.right)
    if left is _NA or right is _NA:
        return False
    return _compare(node.op, left, right)


def _eval_for_all(rows: Sequence[Mapping[str, object]], node: ForAll) -> bool:
    if len(rows) < node.days:
        return False
    window = rows[-node.days :]
    return all(_eval_predicate(window[: i + 1], node.predicate) for i in range(len(window)))


def _eval_exists(rows: Sequence[Mapping[str, object]], node: Exists) -> bool:
    if len(rows) < node.days:
        return False
    window = rows[-node.days :]
    return any(_eval_predicate(window[: i + 1], node.predicate) for i in range(len(window)))


def _eval_consecutive(rows: Sequence[Mapping[str, object]], node: Consecutive) -> bool:
    streak = 0
    longest = 0
    for i in range(len(rows)):
        if _eval_predicate(rows[: i + 1], node.predicate):
            streak += 1
            longest = max(longest, streak)
        else:
            streak = 0
    return longest >= node.min_len


def _eval_scalar(rows: Sequence[Mapping[str, object]], node: Scalar) -> object:
    if isinstance(node, Field):
        return _row_value(rows[-1], node.field)
    if isinstance(node, Const):
        return node.value
    if isinstance(node, Aggregate):
        return _eval_aggregate(rows, node)
    if isinstance(node, PeriodReturn):
        return _eval_period_return(rows, node)
    raise QuantError("EVALUATION_FAILED", f"unhandled Scalar: {type(node).__name__}")


def _eval_aggregate(rows: Sequence[Mapping[str, object]], node: Aggregate) -> object:
    if len(rows) < node.days:
        return _NA
    window = rows[-node.days :]
    values: list[Decimal] = []
    for r in window:
        v = _row_value(r, node.field)
        if v is _NA:
            continue
        values.append(_to_decimal(v))
    if node.agg == "count":
        return Decimal(len(values))
    if not values:
        return _NA
    if node.agg == "mean":
        total = sum(values, Decimal(0))
        return total / len(values)
    if node.agg == "sum":
        return sum(values, Decimal(0))
    if node.agg == "min":
        return min(values)
    if node.agg == "max":
        return max(values)
    raise QuantError("EVALUATION_FAILED", f"unhandled agg: {node.agg!r}")


def _eval_period_return(rows: Sequence[Mapping[str, object]], node: PeriodReturn) -> object:
    if len(rows) < node.days + 1:
        return _NA
    end = _row_value(rows[-1], "close_qfq")
    start = _row_value(rows[-node.days - 1], "close_qfq")
    if end is _NA or start is _NA:
        return _NA
    start_dec = _to_decimal(start)
    if start_dec == 0:
        return _NA
    return (_to_decimal(end) - start_dec) / start_dec


def _row_value(row: Mapping[str, object], field: str) -> object:
    if field not in row:
        return _NA
    v = row[field]
    return _NA if v is None else v


def _compare(op: str, left: object, right: object) -> bool:
    a = _to_decimal(left)
    b = _to_decimal(right)
    if op == "gt":
        return a > b
    if op == "lt":
        return a < b
    if op == "gte":
        return a >= b
    if op == "lte":
        return a <= b
    if op == "eq":
        return a == b
    if op == "neq":
        return a != b
    raise QuantError("EVALUATION_FAILED", f"unhandled compare op: {op!r}")


def _to_decimal(v: object) -> Decimal:
    if isinstance(v, Decimal):
        return v
    if isinstance(v, bool):
        raise QuantError("EVALUATION_FAILED", "bool is not numeric")
    if isinstance(v, (int, float, str)):
        return Decimal(str(v))
    raise QuantError(
        "EVALUATION_FAILED",
        f"cannot coerce {type(v).__name__} to Decimal",
    )
