"""Parse a JSON-shaped dict into the screening AST (RFC 0001 §6).

Pure: takes a ``Mapping`` and returns a typed AST or raises
``QuantError("DSL_INVALID", ...)``. Never touches IO, never mutates.

The function is a hand-rolled validator instead of pydantic so the error
messages can carry a JSON-pointer ``path`` per RFC §6.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING

from quant_core.domain.types.screen import (
    FIELD_NAMES,
    Aggregate,
    Compare,
    Consecutive,
    Const,
    Exists,
    Field,
    ForAll,
    Logical,
    PeriodReturn,
    Predicate,
    Scalar,
    ScreenPlan,
)
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping


_COMPARE_OPS: frozenset[str] = frozenset(("gt", "lt", "gte", "lte", "eq", "neq"))
_LOGICAL_OPS: frozenset[str] = frozenset(("and", "or", "not"))
_AGG_OPS: frozenset[str] = frozenset(("mean", "sum", "min", "max", "count"))


def parse_plan(raw: Mapping[str, object]) -> ScreenPlan:
    """Validate and build a :class:`ScreenPlan` from a raw dict.

    Raises:
        QuantError: ``DSL_INVALID`` on any structural problem; ``details``
            includes a JSON-pointer ``path`` for UI highlighting.
    """
    asof_raw = _require_key(raw, "asof", "/")
    asof = _parse_asof(asof_raw)
    expr_raw = _require_key(raw, "expr", "/")
    expr = parse_predicate(expr_raw, "/expr")
    return ScreenPlan(asof=asof, expr=expr)


def parse_scalar(raw: object, path: str) -> Scalar:
    """Public entry-point for parsing a Scalar AST node.

    Reused by the NL→DSL service to validate ``rank.metric`` payloads.
    Raises ``QuantError("DSL_INVALID")`` on malformed input.
    """
    return _parse_scalar(raw, path)


def parse_predicate(raw: object, path: str) -> Predicate:
    if not isinstance(raw, dict):
        raise _invalid(path, "predicate must be an object")
    op = raw.get("op")
    if not isinstance(op, str):
        raise _invalid(path, "predicate is missing string 'op'")
    if op in _LOGICAL_OPS:
        return _parse_logical(raw, path, op)
    if op in _COMPARE_OPS:
        return _parse_compare(raw, path, op)
    if op == "for_all":
        return _parse_window_assertion(raw, path, op)
    if op == "exists":
        return _parse_window_assertion(raw, path, op)
    if op == "consecutive":
        return _parse_consecutive(raw, path)
    raise _invalid(path, f"unknown op {op!r}")


def _parse_logical(raw: Mapping[str, object], path: str, op: str) -> Logical:
    args_raw = raw.get("args")
    if not isinstance(args_raw, list) or not args_raw:
        raise _invalid(path, f"logical op {op!r} requires non-empty 'args' list")
    if op == "not" and len(args_raw) != 1:
        raise _invalid(path, "logical 'not' must have exactly one arg")
    parts = tuple(parse_predicate(a, f"{path}/args/{i}") for i, a in enumerate(args_raw))
    return Logical(op=op, args=parts)  # type: ignore[arg-type]


def _parse_compare(raw: Mapping[str, object], path: str, op: str) -> Compare:
    left = _parse_scalar(raw.get("left"), f"{path}/left")
    right = _parse_scalar(raw.get("right"), f"{path}/right")
    return Compare(op=op, left=left, right=right)  # type: ignore[arg-type]


def _parse_window_assertion(raw: Mapping[str, object], path: str, op: str) -> Predicate:
    window = raw.get("window")
    if not isinstance(window, dict) or not isinstance(window.get("days"), int):
        raise _invalid(path, f"{op!r} requires window.days as int")
    days = window["days"]
    if not isinstance(days, int) or days <= 0:
        raise _invalid(path, f"window.days must be a positive int, got {days!r}")
    pred_raw = raw.get("predicate")
    if pred_raw is None:
        raise _invalid(path, f"{op!r} requires 'predicate'")
    inner = parse_predicate(pred_raw, f"{path}/predicate")
    if op == "for_all":
        return ForAll(days=days, predicate=inner)
    return Exists(days=days, predicate=inner)


def _parse_consecutive(raw: Mapping[str, object], path: str) -> Consecutive:
    min_len = raw.get("min_len")
    if not isinstance(min_len, int) or min_len <= 0:
        raise _invalid(path, "consecutive.min_len must be a positive int")
    pred_raw = raw.get("predicate")
    if pred_raw is None:
        raise _invalid(path, "consecutive requires 'predicate'")
    inner = parse_predicate(pred_raw, f"{path}/predicate")
    return Consecutive(min_len=min_len, predicate=inner)


def _parse_scalar(raw: object, path: str) -> Scalar:
    if not isinstance(raw, dict):
        raise _invalid(path, "scalar must be an object")
    # Order matters: a plain field carries only ``{"field": ...}``;
    # ``agg`` / ``indicator`` also use ``field`` as a sub-key, so the
    # discriminator key (``agg`` / ``indicator`` / ``period_return`` /
    # ``const``) takes priority.
    if "agg" in raw:
        return _parse_aggregate(raw, path)
    if "indicator" in raw:
        return _parse_indicator(raw, path)
    if "period_return" in raw:
        return _parse_period_return(raw["period_return"], path)
    if "const" in raw:
        return Const(value=_parse_decimal(raw["const"], path))
    if "field" in raw:
        name = raw["field"]
        if not isinstance(name, str) or name not in FIELD_NAMES:
            raise _invalid(path, f"unknown field {name!r}")
        return Field(field=name)
    raise _invalid(path, "scalar must be one of: field/const/agg/period_return/indicator")


def _parse_aggregate(raw: Mapping[str, object], path: str) -> Aggregate:
    agg = raw.get("agg")
    if not isinstance(agg, str) or agg not in _AGG_OPS:
        raise _invalid(path, f"unknown agg {agg!r}")
    field_name = raw.get("field")
    if not isinstance(field_name, str) or field_name not in FIELD_NAMES:
        raise _invalid(path, f"unknown field {field_name!r}")
    window = raw.get("window")
    if not isinstance(window, dict):
        raise _invalid(path, "agg requires 'window'")
    days = window.get("days")
    if not isinstance(days, int) or days <= 0:
        raise _invalid(path, "agg.window.days must be a positive int")
    return Aggregate(agg=agg, field=field_name, days=days)  # type: ignore[arg-type]


def _parse_period_return(raw: object, path: str) -> PeriodReturn:
    if not isinstance(raw, dict):
        raise _invalid(path, "period_return must take a window dict")
    days = raw.get("days")
    if not isinstance(days, int) or days <= 0:
        raise _invalid(path, "period_return.days must be a positive int")
    return PeriodReturn(days=days)


def _parse_indicator(raw: Mapping[str, object], path: str) -> Field:
    """Collapse v1 ``indicator`` into the equivalent precomputed ``Field``.

    RFC §4.3 says the LLM should prefer the precomputed ``ma{N}`` columns;
    we still accept the explicit indicator form but only for the four
    standard windows (5/10/20/60). Non-standard windows are deferred.
    """
    name = raw.get("indicator")
    if name != "ma":
        raise _invalid(path, f"indicator {name!r} not supported in v1")
    period = raw.get("period")
    if period not in (5, 10, 20, 60):
        raise _invalid(path, "indicator.period must be one of 5/10/20/60 in v1")
    return Field(field=f"ma{period}")


def _parse_decimal(raw: object, path: str) -> Decimal:
    if isinstance(raw, bool):
        raise _invalid(path, "const must be a number, not bool")
    if isinstance(raw, (int, float, str)):
        try:
            return Decimal(str(raw))
        except InvalidOperation as exc:
            raise _invalid(path, f"const not parseable as Decimal: {raw!r}") from exc
    raise _invalid(path, f"const must be a number, got {type(raw).__name__}")


def _parse_asof(raw: object) -> date:
    if isinstance(raw, date):
        return raw
    if isinstance(raw, str):
        try:
            return date.fromisoformat(raw)
        except ValueError as exc:
            raise _invalid("/asof", f"asof must be ISO YYYY-MM-DD, got {raw!r}") from exc
    raise _invalid("/asof", f"asof must be a date string, got {type(raw).__name__}")


def _require_key(raw: Mapping[str, object], key: str, path: str) -> object:
    if key not in raw:
        raise _invalid(path, f"missing required key {key!r}")
    return raw[key]


def _invalid(path: str, message: str) -> QuantError:
    return QuantError("DSL_INVALID", message, {"path": path})
