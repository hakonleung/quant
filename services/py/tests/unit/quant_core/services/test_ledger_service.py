"""Unit tests for :class:`LedgerService` — prompt + decode pipeline."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from quant_core.domain.types.ledger import EnrichedLedgerEntry
from quant_core.errors import QuantError
from quant_core.services.ledger_service import LedgerService

from tests._util.clock import FrozenClock

if TYPE_CHECKING:
    from collections.abc import Sequence


_FROZEN: datetime = datetime(2026, 5, 8, 0, 0, 0, tzinfo=UTC)


def _entry(
    *,
    day: int,
    pnl: str = "100",
    closing: str = "100100",
    provided: bool = True,
    cash_flow: str = "0",
    pct: str = "0.1",
) -> EnrichedLedgerEntry:
    return EnrichedLedgerEntry(
        date=date(2026, 5, day),
        pnl_amount=Decimal(pnl),
        closing_position=Decimal(closing),
        closing_provided=provided,
        cash_flow=Decimal(cash_flow),
        derived_daily_pct=Decimal(pct),
    )


class _ScriptedLLM:
    name: str = "fake-llm"

    def __init__(self, responses: list[str]) -> None:
        self._responses = responses
        self.calls: list[dict[str, str]] = []

    def complete_json(self, *, system: str, user: str) -> str:
        self.calls.append({"system": system, "user": user})
        if not self._responses:
            raise QuantError("LLM_FAILED", "no scripted responses left")
        return self._responses.pop(0)

    def complete_with_web_search(
        self, *, system: str, user: str, max_searches: int
    ) -> str:
        raise NotImplementedError


_VALID_PAYLOAD = json.dumps(
    {
        "summary": "整体小幅盈利。",
        "operation_style": "波段操作。",
        "market_view": "震荡偏强。",
        "recommendations": ["保持仓位"],
    },
)


def test_analyze_returns_structured_analysis() -> None:
    llm = _ScriptedLLM([_VALID_PAYLOAD])
    svc = LedgerService(llm=llm, clock=FrozenClock(_FROZEN))
    entries: Sequence[EnrichedLedgerEntry] = (_entry(day=1), _entry(day=2))

    analysis = svc.analyze(entries)

    assert analysis.summary == "整体小幅盈利。"
    assert analysis.operation_style == "波段操作。"
    assert analysis.recommendations == ("保持仓位",)
    assert analysis.window_start == date(2026, 5, 1)
    assert analysis.window_end == date(2026, 5, 2)
    assert analysis.entry_count == 2
    assert analysis.generated_at == _FROZEN
    assert analysis.provider == "fake-llm"


def test_prompt_includes_closing_provided_flag_per_entry() -> None:
    llm = _ScriptedLLM([_VALID_PAYLOAD])
    svc = LedgerService(llm=llm, clock=FrozenClock(_FROZEN))
    entries: Sequence[EnrichedLedgerEntry] = (
        _entry(day=1, provided=True),
        _entry(day=2, provided=False),
    )

    svc.analyze(entries)

    user = llm.calls[0]["user"]
    # CSV body has true/false flags one per row.
    assert "true" in user
    assert "false" in user


def test_analyze_strips_markdown_fenced_json() -> None:
    fenced = "```json\n" + _VALID_PAYLOAD + "\n```"
    llm = _ScriptedLLM([fenced])
    svc = LedgerService(llm=llm, clock=FrozenClock(_FROZEN))
    analysis = svc.analyze((_entry(day=1),))
    assert analysis.summary == "整体小幅盈利。"


def test_analyze_rejects_empty_window() -> None:
    llm = _ScriptedLLM([])
    svc = LedgerService(llm=llm, clock=FrozenClock(_FROZEN))
    with pytest.raises(QuantError) as excinfo:
        svc.analyze(())
    assert excinfo.value.code == "LLM_FAILED"


def test_analyze_rejects_non_json_output() -> None:
    llm = _ScriptedLLM(["not json {{"])
    svc = LedgerService(llm=llm, clock=FrozenClock(_FROZEN))
    with pytest.raises(QuantError) as excinfo:
        svc.analyze((_entry(day=1),))
    assert excinfo.value.code == "LLM_FAILED"


def test_analyze_rejects_non_object_output() -> None:
    llm = _ScriptedLLM(["[1, 2, 3]"])
    svc = LedgerService(llm=llm, clock=FrozenClock(_FROZEN))
    with pytest.raises(QuantError) as excinfo:
        svc.analyze((_entry(day=1),))
    assert excinfo.value.code == "LLM_FAILED"


def test_analyze_rejects_missing_required_field() -> None:
    payload = json.dumps(
        {"summary": "x", "operation_style": "y", "recommendations": []},
    )
    llm = _ScriptedLLM([payload])
    svc = LedgerService(llm=llm, clock=FrozenClock(_FROZEN))
    with pytest.raises(QuantError) as excinfo:
        svc.analyze((_entry(day=1),))
    assert excinfo.value.code == "LLM_FAILED"


def test_analyze_caps_recommendations_at_five() -> None:
    payload = json.dumps(
        {
            "summary": "s",
            "operation_style": "o",
            "market_view": "m",
            "recommendations": [f"建议{i}" for i in range(10)],
        },
    )
    llm = _ScriptedLLM([payload])
    svc = LedgerService(llm=llm, clock=FrozenClock(_FROZEN))
    analysis = svc.analyze((_entry(day=1),))
    assert len(analysis.recommendations) == 5


def test_analyze_skips_empty_recommendation_strings() -> None:
    payload = json.dumps(
        {
            "summary": "s",
            "operation_style": "o",
            "market_view": "m",
            "recommendations": ["", "  ", "保持仓位", "继续观察"],
        },
    )
    llm = _ScriptedLLM([payload])
    svc = LedgerService(llm=llm, clock=FrozenClock(_FROZEN))
    analysis = svc.analyze((_entry(day=1),))
    assert analysis.recommendations == ("保持仓位", "继续观察")
