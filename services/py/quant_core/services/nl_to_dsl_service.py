"""Natural language → screening DSL translation (modules/03-screening.md §6).

Single LLM round-trip with a bounded retry. The service is the *only*
place that knows about prompt content; the LLM client is a generic
"send chat, get JSON text" port.

Output contract:

* :class:`NlToDslResponse.screen_plan` is a validated :class:`ScreenPlan`.
* :class:`NlToDslResponse.universe_plan` is optional — if the LLM
  decided to express a universe pre-filter (ST / 北交所 / 上市天数 / ...)
  it lands here; the caller can hand it straight into the pipeline.
* :class:`NlToDslResponse.rank` is optional — if the LLM detected a
  ranking / top-N intent ("近10日涨幅前 20"), it shows up here and the
  caller hands it into ``ScreenService.execute(rank=...)``.

The system prompt enumerates **exactly** the fields and ops the
parser accepts so the model can't hallucinate unsupported nodes.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from quant_core.domain.rules.screen_parse import parse_plan
from quant_core.domain.rules.universe_parse import parse_universe_plan
from quant_core.domain.types.screen import (
    Aggregate,
    Const,
    Field,
    PeriodReturn,
    RankSpec,
)
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from datetime import date

    from quant_core.domain.types.screen import ScreenPlan
    from quant_core.domain.types.universe_screen import UniversePlan
    from quant_core.ports.llm_client import LLMClient


logger = logging.getLogger(__name__)


_RANK_ORDERS: Final[frozenset[str]] = frozenset(("asc", "desc"))


@dataclass(frozen=True, slots=True)
class NlToDslResponse:
    """Structured payload returned by :meth:`NlToDslService.translate`."""

    screen_plan: ScreenPlan
    universe_plan: UniversePlan | None
    rank: RankSpec | None
    warnings: tuple[str, ...]


class NlToDslService:
    """Translate a Chinese NL query into a validated screening pipeline."""

    __slots__ = ("_llm",)

    def __init__(self, llm: LLMClient) -> None:
        self._llm = llm

    def translate(self, nl_query: str, *, asof: date) -> NlToDslResponse:
        """Run one LLM call (with one retry on validation failure).

        Args:
            nl_query: Raw user input (Chinese expected, but not enforced).
            asof: Absolute reference date — relative time expressions
                like "今天" are forbidden in the AST; the caller resolves
                them upstream and passes the absolute date here so the
                cache key stays stable.

        Returns:
            :class:`NlToDslResponse`.

        Raises:
            QuantError: ``NL_TRANSLATION_FAILED`` when the model output
                is unparseable / unvalidatable on both attempts.
        """
        if not nl_query.strip():
            raise QuantError(
                "NL_TRANSLATION_FAILED",
                "empty natural-language query",
                {"nl_query": nl_query},
            )
        system = _build_system_prompt(asof)
        user = f"User query (Chinese):\n{nl_query.strip()}"
        first_error: str | None = None
        last_raw: str | None = None
        for attempt in range(2):
            raw = self._llm.complete_json(system=system, user=user)
            last_raw = raw
            try:
                return _parse_response(raw, nl_query)
            except QuantError as exc:
                first_error = str(exc)
                logger.warning(
                    "nl_to_dsl_validation_failed",
                    extra={
                        "attempt": attempt,
                        "error": first_error,
                        "details": dict(exc.details),
                        "raw_snippet": raw[:500],
                    },
                )
                # Hand the validator's error back to the model on retry,
                # echoing both the error and the offending JSON so the
                # model can self-correct without guessing.
                user = (
                    f"User query (Chinese):\n{nl_query.strip()}\n\n"
                    f"Your previous JSON failed validation: {first_error}\n"
                    f"Previous JSON was:\n{raw}\n\n"
                    "Emit the corrected JSON only. Do not repeat the same mistake."
                )
        raise QuantError(
            "NL_TRANSLATION_FAILED",
            f"could not produce a valid plan after 2 attempts: {first_error}",
            {"nl_query": nl_query, "last_raw": (last_raw or "")[:1000]},
        )


# -- response parsing ---------------------------------------------------


def _parse_response(raw: str, nl_query: str) -> NlToDslResponse:
    payload = _extract_json(raw)
    if not isinstance(payload, dict):
        raise QuantError(
            "NL_TRANSLATION_FAILED",
            "LLM did not return a JSON object",
            {"nl_query": nl_query},
        )
    plan_raw = payload.get("screen_plan")
    if not isinstance(plan_raw, dict):
        raise QuantError(
            "NL_TRANSLATION_FAILED",
            "missing 'screen_plan' object",
            {"nl_query": nl_query},
        )
    screen_plan = parse_plan(plan_raw)
    universe_plan = None
    universe_raw = payload.get("universe_plan")
    if isinstance(universe_raw, dict):
        universe_plan = parse_universe_plan(universe_raw)
    rank = _parse_rank(payload.get("rank"))
    warnings_raw = payload.get("warnings")
    warnings: tuple[str, ...] = ()
    if isinstance(warnings_raw, list):
        warnings = tuple(w for w in warnings_raw if isinstance(w, str))
    return NlToDslResponse(
        screen_plan=screen_plan,
        universe_plan=universe_plan,
        rank=rank,
        warnings=warnings,
    )


def _extract_json(raw: str) -> object:
    """Pull the first JSON object out of ``raw``.

    LLMs occasionally fence the JSON in ```` ```json ... ``` ```` even when
    asked for raw JSON; we strip that fence if present, then ``json.loads``.
    """
    text = raw.strip()
    fenced = re.match(r"^```(?:json)?\s*(.+?)```$", text, flags=re.DOTALL)
    if fenced is not None:
        text = fenced.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise QuantError(
            "NL_TRANSLATION_FAILED",
            f"LLM output is not valid JSON: {exc.msg}",
            {"snippet": raw[:200]},
        ) from exc


def _parse_rank(raw: object) -> RankSpec | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise QuantError("NL_TRANSLATION_FAILED", "'rank' must be an object")
    metric_raw = raw.get("metric")
    if not isinstance(metric_raw, dict):
        raise QuantError("NL_TRANSLATION_FAILED", "'rank.metric' must be an object")
    metric = _parse_rank_metric(metric_raw)
    order_raw = raw.get("order", "desc")
    if order_raw not in _RANK_ORDERS:
        raise QuantError(
            "NL_TRANSLATION_FAILED",
            f"'rank.order' must be one of {sorted(_RANK_ORDERS)}",
        )
    top_n_raw = raw.get("top_n")
    if top_n_raw is not None and (not isinstance(top_n_raw, int) or top_n_raw < 0):
        raise QuantError("NL_TRANSLATION_FAILED", "'rank.top_n' must be a non-negative int")
    return RankSpec(metric=metric, order=order_raw, top_n=top_n_raw)


def _parse_rank_metric(raw: dict[str, object]) -> Field | Const | Aggregate | PeriodReturn:
    """Reuse the screening parser's scalar shape for rank metrics."""
    from quant_core.domain.rules.screen_parse import parse_scalar

    return parse_scalar(raw, "/rank/metric")


# -- prompt -------------------------------------------------------------


_SCREEN_FIELDS: Final[str] = (
    "open, high, low, close, open_qfq, high_qfq, low_qfq, close_qfq, "
    "volume, amount, turnover_rate, ma5, ma10, ma20, ma60, pct_chg_qfq"
)
_UNIVERSE_FIELDS: Final[str] = (
    "code, name, industries, list_date, float_pct, is_st, exchange, listed_days"
)


def _build_system_prompt(asof: date) -> str:
    return _SYSTEM_PROMPT_TEMPLATE.format(
        asof=asof.isoformat(),
        screen_fields=_SCREEN_FIELDS,
        universe_fields=_UNIVERSE_FIELDS,
    )


# Few-shot examples cover the four canonical cases in modules/03 §3 plus a
# universe pre-filter (ST + 北交所) and a top-N rank, so the LLM sees one
# example of every output channel.
_SYSTEM_PROMPT_TEMPLATE: Final[str] = """\
You translate Chinese stock-screening queries into a strict JSON DSL.

Always respond with ONE JSON object with these top-level keys:

  - "screen_plan"     (required) — the K-line predicate AST
  - "universe_plan"   (optional) — pre-filter on stock metadata
  - "rank"            (optional) — post-processing rank + top-N
  - "warnings"        (optional) — short Chinese strings explaining ambiguity

Hard rules:
  1. Use absolute date {asof} for "asof". NEVER write "today" / "今天".
  2. CRITICAL — every "days" parameter is in **TRADING DAYS** (交易日),
     never calendar days. A股 has roughly 5 trading days per calendar
     week, ~20 per calendar month, ~240 per calendar year. When the user
     mentions a calendar interval ("一年 / 一个月 / 三个月 / N 天 / N 周"),
     you MUST estimate the trading-day count yourself and emit that
     integer. Do NOT pass calendar-day counts.
     Use this conversion table:
       * 一日 / 1 天      → 1
       * 一周 / 5 个交易日 → 5
       * 半个月           → 10
       * 一个月           → 20
       * 三个月 / 一季度  → 60
       * 半年             → 120
       * 一年 / 近一年    → 240
       * 两年             → 480
     If the user gives an explicit "X 个交易日", pass X verbatim.
  3. Prefer the precomputed `ma5/ma10/ma20/ma60` columns over generic indicators.
  4. Use `close_qfq` (前复权) by default; only use `close` if the user explicitly says "不复权".
  5. Conditions about ST / 北交所 / 上市天数 / 行业 belong in `universe_plan`, NOT `screen_plan`.
  6. Top-N / ranking ("前 N", "排序") goes in `rank`, NOT inside the predicate.
  7. NEVER invent ops or fields. The schema is closed. Examples of
     things you must NOT emit: `mul` / `div` / `add` / `sub` (no scalar
     arithmetic), `between` (use `and(gte, lte)`), `rank` inside expr
     (use the top-level `rank` slot), `pe`, `market_cap`, `circ_mv`,
     `listing_age` (use `listed_days`), `last_n` (use a windowed agg).
  8. Map every condition you CAN to the closed schema, even if the
     wording is loose. Examples that LOOK unsupported but ARE expressible:
       * "介于 a 到 b 之间"         → and(gte a, lte b)
       * "近 N 天内某天 X"           → exists window N predicate X
       * "连续 N 天 X"               → consecutive min_len=N predicate X
       * "全部 / 每天 / 都 X"        → for_all window predicate X
       * "X 高于 Y 的 N%" 当 N=100   → gt(X, Y) (the 100% is the identity)
       * "突破 N 日新高"             → gt(close_qfq, max-agg over N)
     Drop a condition ONLY when no valid DSL form exists. Unconditional
     drops + warnings are required for these specific cases (and only
     these — anything else, try harder before dropping):
       * "股价高于 N 月最高价的 K%" with K != 100  — needs scalar multiplication
       * "流通市值 / 总市值 / 市值"   — no market-cap field
       * "市盈率 / PE / PB / ROE"     — no fundamental fields
       * "RSI / MACD / KDJ / BOLL"    — only ma5/ma10/ma20/ma60 exist
     A correctly-translated condition is always better than dropping it.
  9. "实际换手率" is the same column as `turnover_rate`; do not invent
     a separate field for it.
 9a. Standard A-share term mapping for `universe_plan` (use these exact
     thresholds unless the user states their own number):
       * "ST" / "*ST" / "st"       → `is_st = false`
       * "北交所" / "北交"          → `code` not_starts_with one of "8"/"4"/"920"
       * "新股" / "次新股"          → `listed_days >= 90`
       * "上市超过 N 个月"          → `listed_days >= N*30`
       * "上市超过一年"             → `listed_days >= 365`
 10. Inclusive range like "介于 a 到 b 之间" → emit `and` of `gte` + `lte`,
     not a `between` op (which does not exist).

K-line fields (screen_plan): {screen_fields}
Universe fields (universe_plan): {universe_fields}

K-line ops:
  Logical: and / or / not
  Compare: gt / lt / gte / lte / eq / neq
  Window assertions: for_all / exists / consecutive
  Scalars: {{field: ...}}, {{const: <number>}},
           {{agg: mean|sum|min|max|count, field: ..., window: {{days: N}}}},
           {{period_return: {{days: N}}}},
           {{indicator: "ma", field: ..., period: 5|10|20|60}}

Universe ops:
  Logical: and / or / not
  Compare: gt / lt / gte / lte / eq / neq / contains / starts_with / not_starts_with
  Constants: strings, ISO dates (YYYY-MM-DD), numbers, booleans (only for is_st)

Rank shape:
  {{ "metric": <Scalar>, "order": "asc" | "desc", "top_n": int|null }}

Examples:

[Q] 最近5天每天股价都高于ma5
[A] {{
  "screen_plan": {{
    "asof": "{asof}",
    "expr": {{
      "op": "for_all",
      "window": {{"days": 5}},
      "predicate": {{
        "op": "gt",
        "left":  {{"field": "close_qfq"}},
        "right": {{"field": "ma5"}}
      }}
    }}
  }}
}}

[Q] 最近10天平均换手率小于10%
[A] {{
  "screen_plan": {{
    "asof": "{asof}",
    "expr": {{
      "op": "lt",
      "left":  {{"agg": "mean", "field": "turnover_rate", "window": {{"days": 10}}}},
      "right": {{"const": 0.10}}
    }}
  }}
}}

[Q] 最近20天涨幅大于30%, 剔除ST和北交所, 按近10日涨幅取前20
[A] {{
  "screen_plan": {{
    "asof": "{asof}",
    "expr": {{
      "op": "gt",
      "left":  {{"period_return": {{"days": 20}}}},
      "right": {{"const": 0.30}}
    }}
  }},
  "universe_plan": {{
    "asof": "{asof}",
    "expr": {{
      "op": "and",
      "args": [
        {{"op": "eq",              "left": {{"field": "is_st"}},    "right": {{"const": false}}}},
        {{"op": "not_starts_with", "left": {{"field": "code"}},     "right": {{"const": "8"}}}},
        {{"op": "not_starts_with", "left": {{"field": "code"}},     "right": {{"const": "4"}}}},
        {{"op": "not_starts_with", "left": {{"field": "code"}},     "right": {{"const": "920"}}}}
      ]
    }}
  }},
  "rank": {{
    "metric": {{"period_return": {{"days": 10}}}},
    "order": "desc",
    "top_n": 20
  }}
}}
"""
