"""Decoupled NL→DSL and screen-execution Flight ops.

Splits the monolithic :mod:`nl_screen` op into two independent ones so
the frontend can:

* Translate a natural-language sentence into an AST without paying the
  screen-execution cost (e.g. an AST editor that re-uses the LLM).
* Re-run an edited AST without paying the LLM call again.

Both ops emit a single-row Arrow table with a ``payload_json`` column —
same JSON tunnel as :mod:`nl_screen` so the gateway plumbing is uniform.

Wire format for AST round-trip is the *frontend* form
(``packages/shared/src/types/nl-screen.ts``): ``kind``-tagged
discriminated unions. We deserialise that form back into the typed
domain via :func:`_predicate_from_jsonable` and friends — the existing
``screen_parse`` is the LLM input shape (``op``-tagged) and is **not**
compatible with the wire format we serialise out.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import asdict
from datetime import date as date_cls
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Any, Final

import pyarrow as pa
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
    RankSpec,
    Scalar,
    Scale,
    ScreenPlan,
)
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

from quant_rpc.ops.nl_screen import (
    PAYLOAD_SCHEMA,
    _normalise,
    _opt_iso_date,
    _rank_to_jsonable,
    _require_str,
    _screen_plan_to_jsonable,
    _universe_plan_to_jsonable,
)

if TYPE_CHECKING:
    from quant_core.ports.stock_meta_repo import StockMetaRepo
    from quant_core.services.nl_to_dsl_service import NlToDslService
    from quant_core.services.screen_service import ScreenService
    from quant_core.services.universe_screen_service import UniverseScreenService


_NL_TO_DSL_OP: Final[str] = "nl_to_dsl"
_SCREEN_RUN_OP: Final[str] = "screen_run"

_COMPARE_OPS: Final[frozenset[str]] = frozenset(("gt", "lt", "gte", "lte", "eq", "neq"))
_LOGICAL_OPS: Final[frozenset[str]] = frozenset(("and", "or", "not"))
_AGG_OPS: Final[frozenset[str]] = frozenset(("mean", "sum", "min", "max", "count"))
_UNIVERSE_COMPARE_OPS: Final[frozenset[str]] = frozenset(
    ("gt", "lt", "gte", "lte", "eq", "neq", "contains", "starts_with", "not_starts_with")
)


# ---------------------------------------------------------------------------
# wire AST → domain (kind-tagged form, see packages/shared/.../nl-screen.ts)
# ---------------------------------------------------------------------------


def _invalid(path: str, msg: str) -> QuantError:
    return QuantError("DSL_INVALID", f"{path}: {msg}", {"path": path})


def _scalar_from_jsonable(raw: object, path: str) -> Scalar:
    if not isinstance(raw, dict):
        raise _invalid(path, "scalar must be an object")
    kind = raw.get("kind")
    builder = _SCALAR_BUILDERS.get(kind) if isinstance(kind, str) else None
    if builder is None:
        raise _invalid(path, f"unknown scalar kind {kind!r}")
    return builder(raw, path)


def _build_field_scalar(raw: Mapping[str, object], path: str) -> Scalar:
    name = raw.get("field")
    if not isinstance(name, str) or name not in FIELD_NAMES:
        raise _invalid(path, f"unknown field {name!r}")
    return Field(field=name)


def _build_agg_scalar(raw: Mapping[str, object], path: str) -> Scalar:
    agg = raw.get("agg")
    field_name = raw.get("field")
    if not isinstance(agg, str) or agg not in _AGG_OPS:
        raise _invalid(path, f"unknown agg {agg!r}")
    if not isinstance(field_name, str) or field_name not in FIELD_NAMES:
        raise _invalid(path, f"unknown field {field_name!r}")
    days = _window_days(raw.get("window"), path)
    return Aggregate(agg=agg, field=field_name, days=days)  # type: ignore[arg-type]


def _build_scale_scalar(raw: Mapping[str, object], path: str) -> Scalar:
    inner = _scalar_from_jsonable(raw.get("inner"), f"{path}/inner")
    factor = _to_decimal(raw.get("factor"), f"{path}/factor")
    if factor <= 0:
        raise _invalid(f"{path}/factor", f"scale.factor must be > 0, got {factor}")
    return Scale(inner=inner, factor=factor)


def _build_const_scalar(raw: Mapping[str, object], path: str) -> Scalar:
    return Const(value=_to_decimal(raw.get("value"), f"{path}/value"))


def _build_period_return_scalar(raw: Mapping[str, object], path: str) -> Scalar:
    return PeriodReturn(days=_window_days(raw.get("window"), path))


_ScalarBuilder = Callable[[Mapping[str, object], str], Scalar]
_SCALAR_BUILDERS: Final[dict[str, _ScalarBuilder]] = {
    "field": _build_field_scalar,
    "const": _build_const_scalar,
    "agg": _build_agg_scalar,
    "period_return": _build_period_return_scalar,
    "scale": _build_scale_scalar,
}


def _predicate_from_jsonable(raw: object, path: str) -> Predicate:
    if not isinstance(raw, dict):
        raise _invalid(path, "predicate must be an object")
    kind = raw.get("kind")
    builder = _PREDICATE_BUILDERS.get(kind) if isinstance(kind, str) else None
    if builder is None:
        raise _invalid(path, f"unknown predicate kind {kind!r}")
    return builder(raw, path)


def _build_compare_pred(raw: Mapping[str, object], path: str) -> Predicate:
    op = raw.get("op")
    if not isinstance(op, str) or op not in _COMPARE_OPS:
        raise _invalid(path, f"unknown compare op {op!r}")
    left = _scalar_from_jsonable(raw.get("left"), f"{path}/left")
    right = _scalar_from_jsonable(raw.get("right"), f"{path}/right")
    return Compare(op=op, left=left, right=right)  # type: ignore[arg-type]


def _build_logical_pred(raw: Mapping[str, object], path: str) -> Predicate:
    op = raw.get("op")
    if not isinstance(op, str) or op not in _LOGICAL_OPS:
        raise _invalid(path, f"unknown logical op {op!r}")
    args_raw = raw.get("args")
    if not isinstance(args_raw, list) or not args_raw:
        raise _invalid(path, "logical requires non-empty 'args'")
    if op == "not" and len(args_raw) != 1:
        raise _invalid(path, "logical 'not' must have exactly one arg")
    parts = tuple(_predicate_from_jsonable(a, f"{path}/args/{i}") for i, a in enumerate(args_raw))
    return Logical(op=op, args=parts)  # type: ignore[arg-type]


def _build_window_pred(raw: Mapping[str, object], path: str) -> Predicate:
    days = _window_days(raw.get("window"), path)
    inner = _predicate_from_jsonable(raw.get("predicate"), f"{path}/predicate")
    return (
        ForAll(days=days, predicate=inner)
        if raw.get("kind") == "for_all"
        else Exists(days=days, predicate=inner)
    )


def _build_consecutive_pred(raw: Mapping[str, object], path: str) -> Predicate:
    min_len = raw.get("min_len")
    if not isinstance(min_len, int) or min_len <= 0:
        raise _invalid(path, "consecutive.min_len must be a positive int")
    inner = _predicate_from_jsonable(raw.get("predicate"), f"{path}/predicate")
    return Consecutive(min_len=min_len, predicate=inner)


_PredicateBuilder = Callable[[Mapping[str, object], str], Predicate]
_PREDICATE_BUILDERS: Final[dict[str, _PredicateBuilder]] = {
    "compare": _build_compare_pred,
    "logical": _build_logical_pred,
    "for_all": _build_window_pred,
    "exists": _build_window_pred,
    "consecutive": _build_consecutive_pred,
}


def _universe_expr_from_jsonable(raw: object, path: str) -> UniverseExpr:
    if not isinstance(raw, dict):
        raise _invalid(path, "universe expr must be an object")
    kind = raw.get("kind")
    if kind == "compare":
        op = raw.get("op")
        if not isinstance(op, str) or op not in _UNIVERSE_COMPARE_OPS:
            raise _invalid(path, f"unknown universe compare op {op!r}")
        left_raw = raw.get("left")
        if not isinstance(left_raw, dict) or left_raw.get("kind") != "field":
            raise _invalid(path, "universe compare.left must be {kind: 'field', ...}")
        field_name = left_raw.get("field")
        if not isinstance(field_name, str) or field_name not in UNIVERSE_FIELDS:
            raise _invalid(path, f"unknown universe field {field_name!r}")
        right_raw = raw.get("right")
        if not isinstance(right_raw, dict) or right_raw.get("kind") != "const":
            raise _invalid(path, "universe compare.right must be {kind: 'const', ...}")
        return UniverseCompare(
            op=op,  # type: ignore[arg-type]
            left=UniverseField(field=field_name),
            right=UniverseConst(value=_universe_const_value(right_raw.get("value"), path)),
        )
    if kind == "logical":
        op = raw.get("op")
        if not isinstance(op, str) or op not in _LOGICAL_OPS:
            raise _invalid(path, f"unknown universe logical op {op!r}")
        args_raw = raw.get("args")
        if not isinstance(args_raw, list) or not args_raw:
            raise _invalid(path, "universe logical requires non-empty 'args'")
        parts = tuple(
            _universe_expr_from_jsonable(a, f"{path}/args/{i}") for i, a in enumerate(args_raw)
        )
        return UniverseLogical(op=op, args=parts)  # type: ignore[arg-type]
    raise _invalid(path, f"unknown universe expr kind {kind!r}")


def _universe_const_value(v: object, path: str) -> str | int | bool | Decimal | date_cls:
    if isinstance(v, bool):  # before int (bool is int subclass)
        return v
    if isinstance(v, (int, str)):
        # Try ISO date — universe uses list_date as date.
        if isinstance(v, str) and len(v) == 10 and v[4] == "-" and v[7] == "-":
            try:
                return date_cls.fromisoformat(v)
            except ValueError:
                return v
        return v
    if isinstance(v, float):
        return Decimal(str(v))
    raise _invalid(path, f"unsupported const value type {type(v).__name__}")


def _window_days(window: object, path: str) -> int:
    if not isinstance(window, dict):
        raise _invalid(path, "window must be an object")
    days = window.get("days")
    if not isinstance(days, int) or days <= 0:
        raise _invalid(path, f"window.days must be positive int, got {days!r}")
    return days


def _to_decimal(v: object, path: str) -> Decimal:
    if isinstance(v, bool):
        raise _invalid(path, "expected number, got bool")
    if isinstance(v, (int, str, float)):
        try:
            return Decimal(str(v))
        except InvalidOperation as exc:
            raise _invalid(path, f"not parseable as Decimal: {v!r}") from exc
    raise _invalid(path, f"expected number, got {type(v).__name__}")


def _parse_screen_plan(raw: object) -> ScreenPlan:
    if not isinstance(raw, dict):
        raise _invalid("/screenPlan", "screenPlan must be an object")
    asof_raw = raw.get("asof")
    if not isinstance(asof_raw, str):
        raise _invalid("/screenPlan/asof", "asof must be ISO YYYY-MM-DD string")
    try:
        asof = date_cls.fromisoformat(asof_raw)
    except ValueError as exc:
        raise _invalid("/screenPlan/asof", f"invalid ISO date: {asof_raw!r}") from exc
    expr = _predicate_from_jsonable(raw.get("expr"), "/screenPlan/expr")
    return ScreenPlan(asof=asof, expr=expr)


def _parse_universe_plan(raw: object) -> UniversePlan | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise _invalid("/universePlan", "universePlan must be an object or null")
    asof_raw = raw.get("asof")
    if not isinstance(asof_raw, str):
        raise _invalid("/universePlan/asof", "asof must be ISO YYYY-MM-DD string")
    try:
        asof = date_cls.fromisoformat(asof_raw)
    except ValueError as exc:
        raise _invalid("/universePlan/asof", f"invalid ISO date: {asof_raw!r}") from exc
    expr = _universe_expr_from_jsonable(raw.get("expr"), "/universePlan/expr")
    return UniversePlan(asof=asof, expr=expr)


def _parse_rank(raw: object) -> RankSpec | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise _invalid("/rank", "rank must be an object or null")
    metric = _scalar_from_jsonable(raw.get("metric"), "/rank/metric")
    order = raw.get("order")
    if order not in ("asc", "desc"):
        raise _invalid("/rank/order", "order must be 'asc' or 'desc'")
    top_n = raw.get("topN")
    if top_n is not None and (not isinstance(top_n, int) or top_n < 0):
        raise _invalid("/rank/topN", "topN must be a non-negative int or null")
    return RankSpec(metric=metric, order=order, top_n=top_n)


# ---------------------------------------------------------------------------
# handlers
# ---------------------------------------------------------------------------


class NlToDslHandler:
    """``nl_to_dsl`` — translate NL → AST without executing the screen."""

    op = _NL_TO_DSL_OP
    schema = PAYLOAD_SCHEMA

    __slots__ = ("_clock", "_translator")

    def __init__(self, translator: NlToDslService | None, clock: Any) -> None:
        self._translator = translator
        self._clock = clock

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        if self._translator is None:
            raise QuantError(
                "LLM_FAILED",
                "NL translator is not configured (no API key in env)",
                {"reason": "no_provider"},
            )
        nl = _require_str(args, "nl")
        asof = _opt_iso_date(args, "asof") or self._clock.now().date()
        translation = self._translator.translate(nl, asof=asof)
        payload = {
            "nl": nl,
            "asof": asof.isoformat(),
            "screenPlan": _screen_plan_to_jsonable(translation.screen_plan),
            "universePlan": _universe_plan_to_jsonable(translation.universe_plan),
            "rank": _rank_to_jsonable(translation.rank),
        }
        return pa.Table.from_pylist(
            [{"payload_json": json.dumps(payload, ensure_ascii=False)}],
            schema=PAYLOAD_SCHEMA,
        )


class ScreenRunHandler:
    """``screen_run`` — execute an AST (no LLM call)."""

    op = _SCREEN_RUN_OP
    schema = PAYLOAD_SCHEMA

    __slots__ = ("_meta_repo", "_screen_service", "_universe_service")

    def __init__(
        self,
        screen_service: ScreenService,
        universe_service: UniverseScreenService,
        meta_repo: StockMetaRepo,
    ) -> None:
        self._screen_service = screen_service
        self._universe_service = universe_service
        self._meta_repo = meta_repo

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        # The frontend sends the AST as a JSON-encoded string in
        # ``screen_plan`` (mirror of the Arrow tunnel pattern — Flight
        # ``args`` are simple primitives, not nested objects).
        plan_raw = args.get("screen_plan")
        if not isinstance(plan_raw, str) or not plan_raw:
            raise QuantError(
                "INVALID_ARGUMENT",
                "args.screen_plan must be a non-empty JSON string",
                {"key": "screen_plan"},
            )
        universe_raw = args.get("universe_plan")
        rank_raw = args.get("rank")
        try:
            screen_plan = _parse_screen_plan(json.loads(plan_raw))
        except json.JSONDecodeError as exc:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.screen_plan is not valid JSON: {exc.msg}",
                {"key": "screen_plan"},
            ) from exc
        universe_plan = _parse_universe_plan(
            json.loads(universe_raw) if isinstance(universe_raw, str) and universe_raw else None
        )
        rank = _parse_rank(json.loads(rank_raw) if isinstance(rank_raw, str) and rank_raw else None)

        if universe_plan is not None:
            universe = self._universe_service.filter_codes(universe_plan)
        else:
            universe = [m.code for m in self._meta_repo.list_all()]
        result = self._screen_service.execute(screen_plan, universe, rank=rank)
        payload = {
            "matches": [
                {"code": m.code, "evidence": _normalise(asdict(m))["evidence"]}
                for m in result.matches
            ],
            "planSignature": result.plan_signature,
        }
        return pa.Table.from_pylist(
            [{"payload_json": json.dumps(payload, ensure_ascii=False)}],
            schema=PAYLOAD_SCHEMA,
        )
