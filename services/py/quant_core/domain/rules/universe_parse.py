"""Parse a JSON-shaped dict into a :class:`UniversePlan`.

Hand-rolled validator (not pydantic) so error paths carry JSON-pointer
``path`` info matching the screening DSL parser's contract.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, cast

from quant_core.domain.types.universe_screen import (
    UNIVERSE_FIELDS,
    UniverseCompare,
    UniverseConst,
    UniverseExpr,
    UniverseField,
    UniverseLogical,
    UniversePlan,
)
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.domain.types.universe_screen import UniverseCompareOp, UniverseLogicalOp


_COMPARE_OPS: frozenset[str] = frozenset(
    ("gt", "lt", "gte", "lte", "eq", "neq", "contains", "starts_with", "not_starts_with")
)
_LOGICAL_OPS: frozenset[str] = frozenset(("and", "or", "not"))


def parse_universe_plan(raw: Mapping[str, object]) -> UniversePlan:
    asof_raw = _require(raw, "asof", "/")
    asof = _parse_asof(asof_raw)
    expr_raw = _require(raw, "expr", "/")
    return UniversePlan(asof=asof, expr=parse_universe_expr(expr_raw, "/expr"))


def parse_universe_expr(raw: object, path: str) -> UniverseExpr:
    if not isinstance(raw, dict):
        raise _invalid(path, "universe expr must be an object")
    op = raw.get("op")
    if not isinstance(op, str):
        raise _invalid(path, "universe expr is missing string 'op'")
    if op in _LOGICAL_OPS:
        return _parse_logical(raw, path, op)
    if op in _COMPARE_OPS:
        return _parse_compare(raw, path, op)
    raise _invalid(path, f"unknown universe op {op!r}")


def _parse_logical(raw: Mapping[str, object], path: str, op: str) -> UniverseLogical:
    args_raw = raw.get("args")
    if not isinstance(args_raw, list) or not args_raw:
        raise _invalid(path, f"logical op {op!r} requires non-empty 'args' list")
    if op == "not" and len(args_raw) != 1:
        raise _invalid(path, "logical 'not' must have exactly one arg")
    parts = tuple(parse_universe_expr(a, f"{path}/args/{i}") for i, a in enumerate(args_raw))
    return UniverseLogical(op=cast("UniverseLogicalOp", op), args=parts)


def _parse_compare(raw: Mapping[str, object], path: str, op: str) -> UniverseCompare:
    left_raw = raw.get("left")
    if not isinstance(left_raw, dict) or "field" not in left_raw:
        raise _invalid(f"{path}/left", "universe compare 'left' must be a field reference")
    name = left_raw["field"]
    if not isinstance(name, str) or name not in UNIVERSE_FIELDS:
        raise _invalid(f"{path}/left", f"unknown universe field {name!r}")
    right_raw = raw.get("right")
    if not isinstance(right_raw, dict) or "const" not in right_raw:
        raise _invalid(f"{path}/right", "universe compare 'right' must be {const: ...}")
    const = _parse_const(right_raw["const"], name, f"{path}/right")
    return UniverseCompare(
        op=cast("UniverseCompareOp", op),
        left=UniverseField(field=name),
        right=UniverseConst(value=const),
    )


_STRING_FIELDS: frozenset[str] = frozenset(("code", "name", "industries", "exchange"))


def _parse_const(raw: object, field: str, path: str) -> str | int | bool | Decimal | date:
    if field == "is_st":
        return _parse_bool_const(raw, path)
    if field in _STRING_FIELDS:
        return _parse_string_const(raw, field, path)
    if field == "list_date":
        return _parse_date_const(raw, path)
    if field == "listed_days":
        return _parse_int_const(raw, path)
    if field == "float_pct":
        return _parse_decimal_const(raw, path)
    raise _invalid(path, f"unsupported field {field!r}")


def _parse_bool_const(raw: object, path: str) -> bool:
    if isinstance(raw, bool):
        return raw
    raise _invalid(path, "is_st const must be a bool")


def _parse_string_const(raw: object, field: str, path: str) -> str:
    if isinstance(raw, str):
        return raw
    raise _invalid(path, f"{field} const must be a string")


def _parse_date_const(raw: object, path: str) -> date:
    if isinstance(raw, date):
        return raw
    if isinstance(raw, str):
        try:
            return date.fromisoformat(raw)
        except ValueError as exc:
            raise _invalid(path, f"list_date must be ISO YYYY-MM-DD, got {raw!r}") from exc
    raise _invalid(path, "list_date const must be a date string")


def _parse_int_const(raw: object, path: str) -> int:
    if isinstance(raw, bool):
        raise _invalid(path, "listed_days const must be int, not bool")
    if isinstance(raw, int):
        return raw
    raise _invalid(path, "listed_days const must be int")


def _parse_decimal_const(raw: object, path: str) -> Decimal:
    if isinstance(raw, bool):
        raise _invalid(path, "float_pct const must be a number, not bool")
    if isinstance(raw, (int, float, str)):
        try:
            return Decimal(str(raw))
        except InvalidOperation as exc:
            raise _invalid(path, f"float_pct not parseable: {raw!r}") from exc
    raise _invalid(path, "float_pct const must be a number")


def _parse_asof(raw: object) -> date:
    if isinstance(raw, date):
        return raw
    if isinstance(raw, str):
        try:
            return date.fromisoformat(raw)
        except ValueError as exc:
            raise _invalid("/asof", f"asof must be ISO YYYY-MM-DD, got {raw!r}") from exc
    raise _invalid("/asof", f"asof must be a date string, got {type(raw).__name__}")


def _require(raw: Mapping[str, object], key: str, path: str) -> object:
    if key not in raw:
        raise _invalid(path, f"missing required key {key!r}")
    return raw[key]


def _invalid(path: str, message: str) -> QuantError:
    return QuantError("DSL_INVALID", message, {"path": path})
