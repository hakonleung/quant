"""Screening orchestration (modules/03-screening.md §5).

Pulls the universe slice from :class:`KlineRepo` (column- and window-
trimmed by the AST walker), runs the predicate per code, and returns a
:class:`ScreenResult` with one :class:`ScreenMatch` per hit.

Set operations (intersect / union / except) live alongside as plain
functions on :class:`ScreenResult` — the doc says results are combined
*after* execution to keep auditing intact (RFC 0001 §5).
"""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import TYPE_CHECKING, Final

from quant_core.domain.rules.screen_compile import summarise
from quant_core.domain.rules.screen_eval import evaluate_predicate
from quant_core.domain.types.kline import KLINE_FLOOR_DATE
from quant_core.domain.types.screen import (
    Aggregate,
    Compare,
    Const,
    Field,
    ForAll,
    Logical,
    PeriodReturn,
    ScreenMatch,
    ScreenResult,
)
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Sequence

    from quant_core.domain.types.screen import (
        Consecutive,
        Exists,
        Predicate,
        Scalar,
        ScreenPlan,
    )
    from quant_core.ports.kline_repo import KlineRepo


_BUFFER_DAYS: Final[int] = 10
"""Calendar-day cushion added on top of trading-day lookback."""


class ScreenService:
    """Execute :class:`ScreenPlan` against the local K-line cache."""

    __slots__ = ("_kline_repo",)

    def __init__(self, kline_repo: KlineRepo) -> None:
        self._kline_repo = kline_repo

    def execute(self, plan: ScreenPlan, universe: Sequence[str]) -> ScreenResult:
        """Run ``plan`` over ``universe`` and return the matched rows.

        Args:
            plan: The validated AST.
            universe: Codes to consider. Empty is allowed and returns
                an empty result.

        Returns:
            :class:`ScreenResult`. Matches preserve input ``universe``
            order so the UI can render deterministic tables.
        """
        summary = summarise(plan.expr)
        # Required columns plus {trade_date, code}: code so we can group
        # per-stock; trade_date so the per-code rows stay ordered.
        columns = sorted({"trade_date", "code", *summary.columns})
        # Trading days are ~70% of calendar days; widen by 1.6x + buffer
        # to make sure we cover the longest needed lookback.
        calendar_days = int(summary.lookback_days * 1.6) + _BUFFER_DAYS
        start = max(plan.asof - timedelta(days=calendar_days), KLINE_FLOOR_DATE)
        if plan.asof < KLINE_FLOOR_DATE:
            raise QuantError(
                "DSL_INVALID",
                f"asof {plan.asof} precedes KLINE_FLOOR_DATE {KLINE_FLOOR_DATE}",
                {"asof": plan.asof.isoformat()},
            )
        signature = plan_signature(plan)
        if not universe:
            return ScreenResult(asof=plan.asof, plan_signature=signature, matches=())
        table = self._kline_repo.get_universe_slice(
            list(universe), start, plan.asof, columns=columns
        )
        rows_by_code: dict[str, list[dict[str, object]]] = {}
        for row in table.to_pylist():
            code = row.get("code")
            if not isinstance(code, str):
                continue
            rows_by_code.setdefault(code, []).append(dict(row))
        matches: list[ScreenMatch] = []
        for code in universe:
            stock_rows = rows_by_code.get(code, [])
            stock_rows.sort(key=lambda r: r["trade_date"])  # type: ignore[arg-type, return-value]
            if evaluate_predicate(stock_rows, plan.expr):
                matches.append(
                    ScreenMatch(code=code, evidence=_build_evidence(stock_rows, plan.expr))
                )
        return ScreenResult(asof=plan.asof, plan_signature=signature, matches=tuple(matches))


def plan_signature(plan: ScreenPlan) -> str:
    """Deterministic SHA-256 hash of the canonical JSON form of ``plan``.

    Used as the stable cache key for the result (RFC 0001 §12).
    """
    canonical = json.dumps(_plan_to_jsonable(plan), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def intersect(a: ScreenResult, b: ScreenResult) -> ScreenResult:
    _ensure_aligned(a, b)
    b_codes = {m.code for m in b.matches}
    matches = tuple(m for m in a.matches if m.code in b_codes)
    return ScreenResult(asof=a.asof, plan_signature=_combine("intersect", a, b), matches=matches)


def union(a: ScreenResult, b: ScreenResult) -> ScreenResult:
    _ensure_aligned(a, b)
    seen: set[str] = set()
    merged: list[ScreenMatch] = []
    for m in (*a.matches, *b.matches):
        if m.code not in seen:
            seen.add(m.code)
            merged.append(m)
    return ScreenResult(asof=a.asof, plan_signature=_combine("union", a, b), matches=tuple(merged))


def except_(a: ScreenResult, b: ScreenResult) -> ScreenResult:
    _ensure_aligned(a, b)
    b_codes = {m.code for m in b.matches}
    matches = tuple(m for m in a.matches if m.code not in b_codes)
    return ScreenResult(asof=a.asof, plan_signature=_combine("except", a, b), matches=matches)


# -- helpers ------------------------------------------------------------


def _ensure_aligned(a: ScreenResult, b: ScreenResult) -> None:
    if a.asof != b.asof:
        raise QuantError(
            "DSL_INVALID",
            "set operands must share the same asof",
            {"left_asof": a.asof.isoformat(), "right_asof": b.asof.isoformat()},
        )


def _combine(op: str, a: ScreenResult, b: ScreenResult) -> str:
    payload = json.dumps(
        {"op": op, "left": a.plan_signature, "right": b.plan_signature},
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _build_evidence(rows: Sequence[dict[str, object]], _pred: Predicate) -> dict[str, object]:
    """Collect a small evidence payload — first/last bar in the slice.

    The doc calls for richer per-node evidence (RFC 0001 §8). v1 ships a
    minimal version: the date range and the closing price at asof. This
    keeps the surface deterministic; richer extraction is tracked as a
    follow-up.
    """
    if not rows:
        return {"window": [], "values": []}
    first = rows[0]["trade_date"]
    last = rows[-1]["trade_date"]
    values = {
        k: rows[-1][k]
        for k in ("close_qfq", "ma5", "ma10", "ma20", "ma60", "pct_chg_qfq")
        if k in rows[-1]
    }
    return {
        "window": [_iso(first), _iso(last)],
        "asof_values": values,
    }


def _iso(value: object) -> str:
    if hasattr(value, "isoformat"):
        return value.isoformat()  # type: ignore[no-any-return]
    return str(value)


# -- plan → JSON (canonicalisation) -------------------------------------


def _plan_to_jsonable(plan: ScreenPlan) -> dict[str, object]:
    return {"asof": plan.asof.isoformat(), "expr": _node_to_jsonable(plan.expr)}


def _node_to_jsonable(node: object) -> dict[str, object]:
    if isinstance(node, Compare):
        return {
            "op": node.op,
            "left": _scalar_to_jsonable(node.left),
            "right": _scalar_to_jsonable(node.right),
        }
    if isinstance(node, Logical):
        return {"op": node.op, "args": [_node_to_jsonable(a) for a in node.args]}
    if isinstance(node, ForAll):
        return {
            "op": "for_all",
            "window": {"days": node.days},
            "predicate": _node_to_jsonable(node.predicate),
        }
    # Exists and Consecutive handled below — kept inline to avoid extra imports.
    cls_name = type(node).__name__
    if cls_name == "Exists":
        exists: Exists = node  # type: ignore[assignment]
        return {
            "op": "exists",
            "window": {"days": exists.days},
            "predicate": _node_to_jsonable(exists.predicate),
        }
    if cls_name == "Consecutive":
        cons: Consecutive = node  # type: ignore[assignment]
        return {
            "op": "consecutive",
            "min_len": cons.min_len,
            "predicate": _node_to_jsonable(cons.predicate),
        }
    raise QuantError("DSL_INVALID", f"cannot serialise node: {cls_name}")


def _scalar_to_jsonable(node: Scalar) -> dict[str, object]:
    if isinstance(node, Field):
        return {"field": node.field}
    if isinstance(node, Const):
        return {"const": str(node.value)}
    if isinstance(node, Aggregate):
        return {"agg": node.agg, "field": node.field, "window": {"days": node.days}}
    if isinstance(node, PeriodReturn):
        return {"period_return": {"days": node.days}}
    raise QuantError("DSL_INVALID", f"cannot serialise scalar: {type(node).__name__}")
