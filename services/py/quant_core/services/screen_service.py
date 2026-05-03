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
from quant_core.domain.rules.screen_eval import evaluate_predicate, evaluate_scalar
from quant_core.domain.types.kline import KLINE_FLOOR_DATE
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
    RankSpec,
    ScreenMatch,
    ScreenResult,
)
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Sequence

    from quant_core.domain.types.screen import (
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

    def execute(
        self,
        plan: ScreenPlan,
        universe: Sequence[str],
        *,
        rank: RankSpec | None = None,
    ) -> ScreenResult:
        """Run ``plan`` over ``universe`` and return the matched rows.

        Args:
            plan: The validated AST.
            universe: Codes to consider. Empty is allowed and returns
                an empty result.
            rank: Optional ranking + top-N to apply *after* matching.
                When given, matches are reordered by the metric (per-code
                Scalar evaluation) and trimmed to ``rank.top_n`` if set.

        Returns:
            :class:`ScreenResult`. Without ``rank``, matches preserve
            input ``universe`` order. With ``rank``, matches are sorted
            by the chosen metric.
        """
        summary = summarise(plan.expr)
        rank_columns, rank_lookback = _rank_summary(rank)
        columns = sorted({"trade_date", "code", *summary.columns, *rank_columns})
        lookback = max(summary.lookback_days, rank_lookback)
        # Trading days are ~70% of calendar days; widen by 1.6x + buffer
        # to make sure we cover the longest needed lookback.
        calendar_days = int(lookback * 1.6) + _BUFFER_DAYS
        start = max(plan.asof - timedelta(days=calendar_days), KLINE_FLOOR_DATE)
        if plan.asof < KLINE_FLOOR_DATE:
            raise QuantError(
                "DSL_INVALID",
                f"asof {plan.asof} precedes KLINE_FLOOR_DATE {KLINE_FLOOR_DATE}",
                {"asof": plan.asof.isoformat()},
            )
        signature = plan_signature(plan, rank)
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
                evidence = _build_evidence(stock_rows, plan.expr)
                if rank is not None:
                    metric_value = evaluate_scalar(stock_rows, rank.metric)
                    evidence = {**evidence, "rank_metric": _evidence_value(metric_value)}
                matches.append(ScreenMatch(code=code, evidence=evidence))
        if rank is not None:
            matches = _apply_rank(matches, rank)
        return ScreenResult(asof=plan.asof, plan_signature=signature, matches=tuple(matches))


def plan_signature(plan: ScreenPlan, rank: RankSpec | None = None) -> str:
    """Deterministic SHA-256 hash of the canonical JSON form of ``plan``.

    Used as the stable cache key for the result (RFC 0001 §12). When
    ``rank`` is given it is folded into the canonical payload so a
    ranked variant of the same plan keys differently.
    """
    payload: dict[str, object] = _plan_to_jsonable(plan)
    if rank is not None:
        payload["rank"] = {
            "metric": _scalar_to_jsonable(rank.metric),
            "order": rank.order,
            "top_n": rank.top_n,
        }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# -- rank helpers --------------------------------------------------------


def _rank_summary(rank: RankSpec | None) -> tuple[set[str], int]:
    if rank is None:
        return set(), 1
    if isinstance(rank.metric, Field):
        return {rank.metric.field}, 1
    if isinstance(rank.metric, Const):
        return set(), 1
    if isinstance(rank.metric, Aggregate):
        return {rank.metric.field}, rank.metric.days
    if isinstance(rank.metric, PeriodReturn):
        return {"close_qfq"}, rank.metric.days + 1
    raise QuantError("DSL_INVALID", f"unsupported rank metric: {type(rank.metric).__name__}")


def _apply_rank(matches: list[ScreenMatch], rank: RankSpec) -> list[ScreenMatch]:
    """Sort ``matches`` by their pre-computed ``evidence['rank_metric']``.

    Codes whose metric is missing (e.g. insufficient history for
    ``period_return``) sink to the bottom regardless of order.
    """
    from decimal import Decimal

    def key(m: ScreenMatch) -> tuple[int, Decimal]:
        v = m.evidence.get("rank_metric")
        if v is None:
            return (1, Decimal(0))
        try:
            return (0, Decimal(str(v)))
        except (ValueError, ArithmeticError):
            return (1, Decimal(0))

    matches = sorted(
        matches,
        key=key,
        reverse=(rank.order == "desc"),
    )
    if rank.top_n is not None and rank.top_n >= 0:
        matches = matches[: rank.top_n]
    return matches


_EVIDENCE_QUANT: Final = "0.0001"
"""4 decimal places — uniform across every metric the UI / API shows."""


def _evidence_value(v: object) -> object:
    """Coerce eval result to a 4dp string for the evidence dict.

    Decimal results are quantised to 4 decimal places so prices, ratios,
    returns, and rank metrics all share the same display precision. The
    underlying Parquet schema keeps its native precision (4dp prices /
    6dp rates) — this is purely the user-visible surface.
    """
    from decimal import Decimal, InvalidOperation

    if isinstance(v, Decimal):
        try:
            return str(v.quantize(Decimal(_EVIDENCE_QUANT)))
        except InvalidOperation:
            return str(v)
    if isinstance(v, (int, float)):
        try:
            return str(Decimal(str(v)).quantize(Decimal(_EVIDENCE_QUANT)))
        except InvalidOperation:
            return v
    return None if not isinstance(v, (str, bool)) else v


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


def _build_evidence(rows: Sequence[dict[str, object]], pred: Predicate) -> dict[str, object]:
    """Collect window + per-condition derived fields for a matched stock.

    For every Scalar that participates in a ``Compare`` inside ``pred``,
    we evaluate it against ``rows`` and attach the value under a
    deterministic, human-readable key (e.g. ``"period_return_20d"``,
    ``"mean_turnover_rate_10d"``, ``"close_qfq"``). This lets the UI
    render a per-stock breakdown of "why did this code match" without
    re-evaluating the AST.
    """
    if not rows:
        return {"window": [], "metrics": {}}
    first = rows[0]["trade_date"]
    last = rows[-1]["trade_date"]
    metrics: dict[str, object] = {}
    for scalar in _collect_compare_scalars(pred):
        name = _scalar_label(scalar)
        if name is None or name in metrics:
            continue
        value = evaluate_scalar(rows, scalar)
        metrics[name] = _evidence_value(value)
    return {"window": [_iso(first), _iso(last)], "metrics": metrics}


def _collect_compare_scalars(pred: Predicate) -> list[Scalar]:
    """Walk ``pred`` and emit every Scalar that drives a Compare node.

    Const nodes are skipped (no metric to display). Order is the AST
    traversal order so callers see the same labelling on each match.
    """
    out: list[Scalar] = []
    _walk_for_metrics(pred, out)
    return out


def _walk_for_metrics(node: Predicate, out: list[Scalar]) -> None:
    if isinstance(node, Compare):
        for side in (node.left, node.right):
            if not isinstance(side, Const):
                out.append(side)
        return
    if isinstance(node, Logical):
        for arg in node.args:
            _walk_for_metrics(arg, out)
        return
    if isinstance(node, (ForAll, Exists, Consecutive)):
        _walk_for_metrics(node.predicate, out)


def _scalar_label(scalar: Scalar) -> str | None:
    """Deterministic name for a Scalar — used as the evidence dict key."""
    if isinstance(scalar, Field):
        return scalar.field
    if isinstance(scalar, Aggregate):
        return f"{scalar.agg}_{scalar.field}_{scalar.days}d"
    if isinstance(scalar, PeriodReturn):
        return f"period_return_{scalar.days}d"
    return None


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
