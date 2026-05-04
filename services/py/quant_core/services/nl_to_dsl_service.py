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
    RankSpec,
    Scalar,
)
from quant_core.errors import QuantError
from quant_core.prompts import build_nl_to_dsl_system_prompt

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
        system = build_nl_to_dsl_system_prompt(asof)
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


def _parse_rank_metric(raw: dict[str, object]) -> Scalar:
    """Reuse the screening parser's scalar shape for rank metrics."""
    from quant_core.domain.rules.screen_parse import parse_scalar

    return parse_scalar(raw, "/rank/metric")
