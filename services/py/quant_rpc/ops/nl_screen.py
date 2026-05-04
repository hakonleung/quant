"""Flight op for the NL → DSL → screen pipeline (modules/03-screening.md
§5 + modules/07-frontend.md §4.3).

The frontend posts a natural-language sentence; the gateway runs:

1. :class:`NlToDslService` (paid LLM call) → ``ScreenPlan`` (+ optional
   ``UniversePlan``).
2. :class:`UniverseScreenService` (if a universe filter was emitted) to
   trim the candidate code set.
3. :class:`ScreenService` to evaluate the predicate over the trimmed
   universe and produce per-code matches with evidence.

The op returns a single-row Arrow table whose only column is a JSON
payload carrying both the parsed AST (for the UI's "render as
conditions" panel) and the resulting matches:

.. code-block:: json

    {
      "nl": "rsi14<25 & vol_z>1",
      "asof": "2026-05-03",
      "screenPlan":   { "asof": "...", "expr": { ... AST ... } },
      "universePlan": { "asof": "...", "expr": { ... } } | null,
      "matches": [{ "code": "600519", "evidence": { ... } }, ...]
    }

Riding the JSON tunnel (same trick as the sentiment ops): the AST is
deeply nested, so columnar transport buys us nothing here.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import date as date_cls
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import TYPE_CHECKING, Any, Final

import pyarrow as pa
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
from quant_core.domain.types.universe_screen import (
    UniverseCompare,
    UniverseConst,
    UniverseLogical,
)
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.domain.types.screen import (
        Predicate,
        Scalar,
        ScreenPlan,
    )
    from quant_core.domain.types.universe_screen import UniverseExpr, UniversePlan
    from quant_core.ports.stock_meta_repo import StockMetaRepo
    from quant_core.services.nl_to_dsl_service import NlToDslService
    from quant_core.services.screen_service import ScreenService
    from quant_core.services.universe_screen_service import UniverseScreenService


PAYLOAD_SCHEMA: Final[pa.Schema] = pa.schema([("payload_json", pa.string())])

_OP_NAME: Final[str] = "nl_screen"


# ---------------------------------------------------------------------------
# arg parsing
# ---------------------------------------------------------------------------


def _require_str(args: Mapping[str, object], key: str) -> str:
    raw = args.get(key)
    if not isinstance(raw, str) or not raw:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a non-empty string",
            {"key": key},
        )
    return raw


def _opt_iso_date(args: Mapping[str, object], key: str) -> date_cls | None:
    raw = args.get(key)
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be an ISO-8601 date",
            {"key": key, "got": type(raw).__name__},
        )
    try:
        return date_cls.fromisoformat(raw)
    except ValueError as exc:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} is not a valid ISO date",
            {"key": key, "value": raw},
        ) from exc


# ---------------------------------------------------------------------------
# AST → JSON
# ---------------------------------------------------------------------------


def _normalise(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _normalise(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_normalise(v) for v in obj]
    if isinstance(obj, (date_cls, datetime)):
        return obj.isoformat()
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, Decimal):
        return str(obj)
    return obj


def _scalar_to_jsonable(node: Scalar) -> dict[str, object]:
    if isinstance(node, Field):
        return {"kind": "field", "field": node.field}
    if isinstance(node, Const):
        return {"kind": "const", "value": str(node.value)}
    if isinstance(node, Aggregate):
        return {
            "kind": "agg",
            "agg": node.agg,
            "field": node.field,
            "window": {"days": node.days},
        }
    if isinstance(node, PeriodReturn):
        return {"kind": "period_return", "window": {"days": node.days}}
    if isinstance(node, Scale):
        return {
            "kind": "scale",
            "inner": _scalar_to_jsonable(node.inner),
            "factor": str(node.factor),
        }
    raise QuantError("DSL_INVALID", f"cannot serialise scalar: {type(node).__name__}")


def _predicate_to_jsonable(node: Predicate) -> dict[str, object]:
    if isinstance(node, Compare):
        return {
            "kind": "compare",
            "op": node.op,
            "left": _scalar_to_jsonable(node.left),
            "right": _scalar_to_jsonable(node.right),
        }
    if isinstance(node, Logical):
        return {
            "kind": "logical",
            "op": node.op,
            "args": [_predicate_to_jsonable(a) for a in node.args],
        }
    if isinstance(node, ForAll):
        return {
            "kind": "for_all",
            "window": {"days": node.days},
            "predicate": _predicate_to_jsonable(node.predicate),
        }
    if isinstance(node, Exists):
        return {
            "kind": "exists",
            "window": {"days": node.days},
            "predicate": _predicate_to_jsonable(node.predicate),
        }
    if isinstance(node, Consecutive):
        return {
            "kind": "consecutive",
            "min_len": node.min_len,
            "predicate": _predicate_to_jsonable(node.predicate),
        }
    raise QuantError("DSL_INVALID", f"cannot serialise predicate: {type(node).__name__}")


def _screen_plan_to_jsonable(plan: ScreenPlan) -> dict[str, object]:
    return {"asof": plan.asof.isoformat(), "expr": _predicate_to_jsonable(plan.expr)}


def _universe_expr_to_jsonable(expr: UniverseExpr) -> dict[str, object]:
    if isinstance(expr, UniverseCompare):
        return {
            "kind": "compare",
            "op": expr.op,
            "left": {"kind": "field", "field": expr.left.field},
            "right": {"kind": "const", "value": _const_value(expr.right)},
        }
    if isinstance(expr, UniverseLogical):
        return {
            "kind": "logical",
            "op": expr.op,
            "args": [_universe_expr_to_jsonable(a) for a in expr.args],
        }
    raise QuantError("DSL_INVALID", f"cannot serialise universe expr: {type(expr).__name__}")


def _const_value(c: UniverseConst) -> object:
    v = c.value
    if isinstance(v, (date_cls, datetime)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return str(v)
    return v


def _universe_plan_to_jsonable(plan: UniversePlan | None) -> dict[str, object] | None:
    if plan is None:
        return None
    return {"asof": plan.asof.isoformat(), "expr": _universe_expr_to_jsonable(plan.expr)}


# ---------------------------------------------------------------------------
# handler
# ---------------------------------------------------------------------------


class NlScreenHandler:
    """``nl_screen`` — full natural-language → matches + AST pipeline."""

    op = _OP_NAME
    schema = PAYLOAD_SCHEMA

    __slots__ = ("_clock", "_meta_repo", "_screen_service", "_translator", "_universe_service")

    def __init__(
        self,
        translator: NlToDslService | None,
        screen_service: ScreenService,
        universe_service: UniverseScreenService,
        meta_repo: StockMetaRepo,
        clock: Any,
    ) -> None:
        self._translator = translator
        self._screen_service = screen_service
        self._universe_service = universe_service
        self._meta_repo = meta_repo
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
        screen_plan = translation.screen_plan
        universe_plan = translation.universe_plan
        if universe_plan is not None:
            universe = self._universe_service.filter_codes(universe_plan)
        else:
            universe = [m.code for m in self._meta_repo.list_all()]
        result = self._screen_service.execute(screen_plan, universe)
        payload: dict[str, object] = {
            "nl": nl,
            "asof": asof.isoformat(),
            "screenPlan": _screen_plan_to_jsonable(screen_plan),
            "universePlan": _universe_plan_to_jsonable(universe_plan),
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
