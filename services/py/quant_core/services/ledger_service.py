"""Personal-ledger AI analysis service.

Single public method :meth:`LedgerService.analyze`:

1. Render system + user prompts (`quant_core.prompts.ledger_prompts`).
2. Call the chained LLM (Kimi Pro preferred) and JSON-decode the reply.
3. Validate the structured payload → :class:`LedgerAnalysis`.

Persistence (entries + analysis cache) lives entirely on the NestJS
side. This service is stateless — every call walks the prompt /
LLM / decode pipeline, and the caller is expected to gate on its own
hash-based cache before invoking us. Keeping it stateless means we do
not own a cache port and tests don't need fakes for one.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Final

from quant_core.domain.types.ledger import LedgerAnalysis
from quant_core.errors import QuantError
from quant_core.prompts.ledger_prompts import (
    build_ledger_system_prompt,
    build_ledger_user_prompt,
)

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import datetime

    from quant_core.domain.types.ledger import EnrichedLedgerEntry
    from quant_core.ports.clock import Clock
    from quant_core.ports.llm_client import LLMClient


logger = logging.getLogger(__name__)


_MAX_RECOMMENDATIONS: Final[int] = 5


class LedgerService:
    """Stateless prompt → LLM → decode pipeline."""

    __slots__ = ("_clock", "_llm")

    def __init__(self, *, llm: LLMClient, clock: Clock) -> None:
        self._llm = llm
        self._clock = clock

    def analyze(self, entries: Sequence[EnrichedLedgerEntry]) -> LedgerAnalysis:
        """Return a :class:`LedgerAnalysis` for the supplied window.

        Args:
            entries: Up to 30 enriched entries — the caller has already
                clipped the window and resolved the chain.

        Raises:
            QuantError: ``LLM_FAILED`` when the LLM call fails or the
                output is not a valid JSON object matching the prompt
                schema.
        """
        if len(entries) == 0:
            raise QuantError("LLM_FAILED", "ledger window is empty")

        system = build_ledger_system_prompt()
        user = build_ledger_user_prompt(entries)
        raw = self._llm.complete_json(system=system, user=user)
        payload = _parse_json_object(raw)
        return _build_analysis(
            payload,
            entries=entries,
            generated_at=self._clock.now(),
            provider=_provider_of(self._llm),
        )


# ---------------------------------------------------------------------------
# JSON → domain decoding
# ---------------------------------------------------------------------------


def _parse_json_object(raw: str) -> dict[str, object]:
    text = raw.strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1:
            text = text[first_newline + 1 :]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise QuantError(
            "LLM_FAILED",
            f"ledger output is not valid JSON: {exc.msg}",
            {"snippet": raw[:200]},
        ) from exc
    if not isinstance(payload, dict):
        raise QuantError("LLM_FAILED", "ledger output is not a JSON object")
    return payload


def _provider_of(llm: object) -> str:
    name = getattr(llm, "name", "")
    return name if isinstance(name, str) else ""


def _decode_str(payload: dict[str, object], key: str) -> str:
    raw = payload.get(key)
    if not isinstance(raw, str):
        raise QuantError(
            "LLM_FAILED",
            f"ledger output {key!r} must be a string",
            {"got": type(raw).__name__},
        )
    stripped = raw.strip()
    if not stripped:
        raise QuantError("LLM_FAILED", f"ledger output {key!r} is empty")
    return stripped


def _decode_string_list(raw: object) -> tuple[str, ...]:
    if not isinstance(raw, list):
        return ()
    out: list[str] = []
    for entry in raw:
        if not isinstance(entry, str):
            continue
        stripped = entry.strip()
        if not stripped:
            continue
        out.append(stripped)
        if len(out) >= _MAX_RECOMMENDATIONS:
            break
    return tuple(out)


def _build_analysis(
    payload: dict[str, object],
    *,
    entries: Sequence[EnrichedLedgerEntry],
    generated_at: datetime,
    provider: str,
) -> LedgerAnalysis:
    summary = _decode_str(payload, "summary")
    operation_style = _decode_str(payload, "operation_style")
    market_view = _decode_str(payload, "market_view")
    recommendations = _decode_string_list(payload.get("recommendations"))
    first = entries[0]
    last = entries[-1]
    return LedgerAnalysis(
        summary=summary,
        operation_style=operation_style,
        market_view=market_view,
        recommendations=recommendations,
        generated_at=generated_at,
        window_start=first.date,
        window_end=last.date,
        entry_count=len(entries),
        provider=provider,
    )
