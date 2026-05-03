"""Evaluate a :class:`UniversePlan` against a list of :class:`StockMeta`.

Pure: no IO, no clock — derived fields (``listed_days``) take ``asof``
from the plan.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from quant_core.domain.types.universe_screen import (
    UniverseCompare,
    UniverseField,
    UniverseLogical,
)
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from datetime import date

    from quant_core.domain.types.stock import StockMeta
    from quant_core.domain.types.universe_screen import UniverseExpr, UniversePlan


_ST_PREFIXES: Final[tuple[str, ...]] = ("ST", "*ST", "S*ST", "SST")


def evaluate_universe(plan: UniversePlan, metas: list[StockMeta]) -> list[StockMeta]:
    """Filter ``metas`` down to those satisfying ``plan.expr``."""
    return [m for m in metas if _eval_expr(plan.expr, m, plan.asof)]


def _eval_expr(expr: UniverseExpr, meta: StockMeta, asof: date) -> bool:
    if isinstance(expr, UniverseLogical):
        if expr.op == "not":
            return not _eval_expr(expr.args[0], meta, asof)
        if expr.op == "and":
            return all(_eval_expr(a, meta, asof) for a in expr.args)
        return any(_eval_expr(a, meta, asof) for a in expr.args)
    if isinstance(expr, UniverseCompare):
        return _eval_compare(expr, meta, asof)
    raise QuantError("EVALUATION_FAILED", f"unhandled universe node: {type(expr).__name__}")


def _eval_compare(node: UniverseCompare, meta: StockMeta, asof: date) -> bool:
    left = _resolve_field(node.left, meta, asof)
    right = node.right.value
    op = node.op
    if op == "contains":
        return isinstance(left, str) and isinstance(right, str) and right in left
    if op == "starts_with":
        return isinstance(left, str) and isinstance(right, str) and left.startswith(right)
    if op == "not_starts_with":
        return isinstance(left, str) and isinstance(right, str) and not left.startswith(right)
    # Numeric / ordered compare
    if op == "eq":
        return left == right
    if op == "neq":
        return left != right
    if op in {"gt", "lt", "gte", "lte"}:
        return _ordered_compare(op, left, right)
    raise QuantError("EVALUATION_FAILED", f"unhandled universe compare op: {op!r}")


def _ordered_compare(op: str, left: object, right: object) -> bool:
    """Date / int / Decimal — defer to native ordering.

    The parser aligns ``left`` and ``right`` to the same scalar type
    (e.g. both Decimal, both date), so the comparisons below are safe at
    runtime. The type system can't see that invariant, so we tag the
    operators.
    """
    if isinstance(left, bool) or isinstance(right, bool):
        raise QuantError("EVALUATION_FAILED", "ordered compare not supported on bool")
    try:
        if op == "gt":
            return bool(left > right)  # type: ignore[operator]
        if op == "lt":
            return bool(left < right)  # type: ignore[operator]
        if op == "gte":
            return bool(left >= right)  # type: ignore[operator]
        return bool(left <= right)  # type: ignore[operator]
    except TypeError as exc:
        raise QuantError(
            "EVALUATION_FAILED",
            f"values not orderable: {type(left).__name__} vs {type(right).__name__}",
        ) from exc


def _resolve_field(field: UniverseField, meta: StockMeta, asof: date) -> object:
    name = field.field
    if name == "code":
        return meta.code
    if name == "name":
        return meta.name
    if name == "industries":
        return meta.industries
    if name == "list_date":
        return meta.list_date
    if name == "float_pct":
        return meta.float_pct
    if name == "is_st":
        return _is_st(meta.name)
    if name == "exchange":
        return _exchange_for_code(meta.code)
    if name == "listed_days":
        return (asof - meta.list_date).days
    raise QuantError("EVALUATION_FAILED", f"unhandled universe field: {name!r}")


def _is_st(name: str) -> bool:
    upper = name.strip().upper()
    return any(upper.startswith(p) for p in _ST_PREFIXES)


def _exchange_for_code(code: str) -> str:
    """Match the prefix table in ``akshare_stock_meta._exchange_for_code``.

    Returns a sentinel ``"unknown"`` if the code shape isn't recognised
    (so eq/neq still compare cleanly without raising).
    """
    if not (code.isdigit() and len(code) == 6):
        return "unknown"
    if code.startswith("920"):
        return "bj"
    if code.startswith(("60", "68", "900")):
        return "sh"
    if code.startswith(("00", "30", "20")):
        return "sz"
    if code.startswith(("4", "8")):
        return "bj"
    return "unknown"


__all__ = ["evaluate_universe"]
