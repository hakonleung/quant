"""Unit tests for the ``analyze_ledger`` Flight op handler."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from quant_core.domain.types.ledger import LedgerAnalysis
from quant_core.errors import QuantError

from quant_rpc.ops.ledger import AnalyzeLedgerHandler

if TYPE_CHECKING:
    from collections.abc import Sequence

    from quant_core.domain.types.ledger import EnrichedLedgerEntry


class _ScriptedService:
    def __init__(self, *, payload: LedgerAnalysis | None = None, raise_with: QuantError | None = None) -> None:
        self._payload = payload
        self._raise = raise_with
        self.calls: list[Sequence[EnrichedLedgerEntry]] = []

    def analyze(self, entries: Sequence[EnrichedLedgerEntry]) -> LedgerAnalysis:
        self.calls.append(tuple(entries))
        if self._raise is not None:
            raise self._raise
        assert self._payload is not None
        return self._payload


_VALID_ENTRY: dict[str, object] = {
    "date": "2026-05-01",
    "pnl_amount": "100",
    "closing_position": "100100",
    "closing_provided": True,
    "cash_flow": "0",
    "derived_daily_pct": "0.1",
}


_SAMPLE_ANALYSIS = LedgerAnalysis(
    summary="整体小幅盈利",
    operation_style="波段操作",
    market_view="震荡偏强",
    recommendations=("保持仓位",),
    generated_at=datetime(2026, 5, 8, 0, 0, 0, tzinfo=UTC),
    window_start=date(2026, 5, 1),
    window_end=date(2026, 5, 1),
    entry_count=1,
    provider="moonshot",
)


def test_handler_returns_payload_table_with_camelcase_keys() -> None:
    svc = _ScriptedService(payload=_SAMPLE_ANALYSIS)
    handler = AnalyzeLedgerHandler(svc)
    table = handler.execute({"entries": [_VALID_ENTRY]})

    assert table.num_rows == 1
    payload = json.loads(table.to_pylist()[0]["payload_json"])
    # camelCase wire shape — TS schema validates these names directly.
    assert payload["summary"] == "整体小幅盈利"
    assert payload["operationStyle"] == "波段操作"
    assert payload["marketView"] == "震荡偏强"
    assert payload["recommendations"] == ["保持仓位"]
    assert payload["entryCount"] == 1
    assert payload["windowStart"] == "2026-05-01"
    assert payload["provider"] == "moonshot"
    assert "schemaVersion" not in payload  # explicitly stripped


def test_handler_decodes_decimal_strings_to_decimals() -> None:
    svc = _ScriptedService(payload=_SAMPLE_ANALYSIS)
    handler = AnalyzeLedgerHandler(svc)
    handler.execute({"entries": [_VALID_ENTRY]})

    entry = svc.calls[0][0]
    assert entry.pnl_amount == Decimal("100")
    assert entry.closing_position == Decimal("100100")
    assert entry.closing_provided is True
    assert entry.cash_flow == Decimal("0")
    assert entry.derived_daily_pct == Decimal("0.1")
    assert entry.date == date(2026, 5, 1)


def test_handler_rejects_when_service_unconfigured() -> None:
    handler = AnalyzeLedgerHandler(None)
    with pytest.raises(QuantError) as excinfo:
        handler.execute({"entries": [_VALID_ENTRY]})
    assert excinfo.value.code == "LLM_FAILED"


def test_handler_rejects_missing_entries_key() -> None:
    svc = _ScriptedService(payload=_SAMPLE_ANALYSIS)
    handler = AnalyzeLedgerHandler(svc)
    with pytest.raises(QuantError) as excinfo:
        handler.execute({})
    assert excinfo.value.code == "INVALID_ARGUMENT"


def test_handler_rejects_empty_entries() -> None:
    svc = _ScriptedService(payload=_SAMPLE_ANALYSIS)
    handler = AnalyzeLedgerHandler(svc)
    with pytest.raises(QuantError) as excinfo:
        handler.execute({"entries": []})
    assert excinfo.value.code == "INVALID_ARGUMENT"


def test_handler_rejects_oversized_window() -> None:
    svc = _ScriptedService(payload=_SAMPLE_ANALYSIS)
    handler = AnalyzeLedgerHandler(svc)
    too_many = [{**_VALID_ENTRY, "date": f"2026-04-{i:02d}"} for i in range(1, 32)]
    with pytest.raises(QuantError) as excinfo:
        handler.execute({"entries": too_many})
    assert excinfo.value.code == "INVALID_ARGUMENT"


def test_handler_rejects_invalid_date() -> None:
    svc = _ScriptedService(payload=_SAMPLE_ANALYSIS)
    handler = AnalyzeLedgerHandler(svc)
    bad = {**_VALID_ENTRY, "date": "not-a-date"}
    with pytest.raises(QuantError) as excinfo:
        handler.execute({"entries": [bad]})
    assert excinfo.value.code == "INVALID_ARGUMENT"


def test_handler_rejects_non_bool_closing_provided() -> None:
    svc = _ScriptedService(payload=_SAMPLE_ANALYSIS)
    handler = AnalyzeLedgerHandler(svc)
    bad = {**_VALID_ENTRY, "closing_provided": "yes"}
    with pytest.raises(QuantError) as excinfo:
        handler.execute({"entries": [bad]})
    assert excinfo.value.code == "INVALID_ARGUMENT"


def test_handler_propagates_service_quant_error() -> None:
    svc = _ScriptedService(raise_with=QuantError("LLM_FAILED", "boom"))
    handler = AnalyzeLedgerHandler(svc)
    with pytest.raises(QuantError) as excinfo:
        handler.execute({"entries": [_VALID_ENTRY]})
    assert excinfo.value.code == "LLM_FAILED"
