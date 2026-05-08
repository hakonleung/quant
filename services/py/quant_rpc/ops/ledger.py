"""Flight op for ledger AI analysis.

Mirrors the ``ta`` surface: returns one row in :data:`PAYLOAD_SCHEMA`
whose only column is the JSON-encoded :class:`LedgerAnalysis`. The JSON
tunnel is the right call here — payloads are tiny strings, not columnar
data — and the gateway already has the matching mapper.
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
from quant_core.domain.types.ledger import EnrichedLedgerEntry
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from quant_core.domain.types.ledger import LedgerAnalysis
    from quant_core.services.ledger_service import LedgerService


PAYLOAD_SCHEMA: Final[pa.Schema] = pa.schema([("payload_json", pa.string())])

_MAX_WINDOW: Final[int] = 30


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


def _to_camel(snake: str) -> str:
    parts = snake.split("_")
    return parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])


def _payload_table(value: LedgerAnalysis) -> pa.Table:
    snake = _normalise(asdict(value))
    if not isinstance(snake, dict):  # pragma: no cover - defensive
        raise QuantError("INTERNAL", "asdict did not produce a dict")
    # Drop schema_version, project to the camelCase shape the TS schema
    # validates (cross-process contract: Python is source of truth on
    # *fields*, but the wire shape uses the JS convention).
    camel: dict[str, object] = {}
    for k, v in snake.items():
        if k == "schema_version":
            continue
        camel[_to_camel(k)] = v
    payload = json.dumps(camel, ensure_ascii=False)
    return pa.Table.from_pylist([{"payload_json": payload}], schema=PAYLOAD_SCHEMA)


def _require_list(args: Mapping[str, object], key: str) -> list[Mapping[str, object]]:
    raw = args.get(key)
    if not isinstance(raw, list):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a list",
            {"key": key, "got": type(raw).__name__},
        )
    out: list[Mapping[str, object]] = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.{key}[{i}] must be an object",
                {"key": key, "index": i},
            )
        out.append(entry)
    return out


def _coerce_date(value: object, *, key: str) -> date_cls:
    if isinstance(value, date_cls):
        return value
    if isinstance(value, str):
        try:
            return date_cls.fromisoformat(value[:10])
        except ValueError as exc:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"{key} is not a YYYY-MM-DD date: {value!r}",
                {"key": key},
            ) from exc
    raise QuantError(
        "INVALID_ARGUMENT",
        f"{key} must be a YYYY-MM-DD string",
        {"key": key, "got": type(value).__name__},
    )


def _coerce_decimal(value: object, *, key: str) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"{key} must be a numeric string, got bool",
            {"key": key},
        )
    if isinstance(value, (int, float, str)):
        try:
            return Decimal(str(value))
        except Exception as exc:  # pragma: no cover - covered indirectly via tests
            raise QuantError(
                "INVALID_ARGUMENT",
                f"{key} is not a valid decimal: {value!r}",
                {"key": key},
            ) from exc
    raise QuantError(
        "INVALID_ARGUMENT",
        f"{key} must be a numeric string",
        {"key": key, "got": type(value).__name__},
    )


def _coerce_bool(value: object, *, key: str) -> bool:
    if isinstance(value, bool):
        return value
    raise QuantError(
        "INVALID_ARGUMENT",
        f"{key} must be a boolean",
        {"key": key, "got": type(value).__name__},
    )


def _decode_entries(raw: Sequence[Mapping[str, object]]) -> list[EnrichedLedgerEntry]:
    out: list[EnrichedLedgerEntry] = []
    for entry in raw:
        out.append(
            EnrichedLedgerEntry(
                date=_coerce_date(entry.get("date"), key="entries[].date"),
                pnl_amount=_coerce_decimal(entry.get("pnl_amount"), key="entries[].pnl_amount"),
                closing_position=_coerce_decimal(
                    entry.get("closing_position"),
                    key="entries[].closing_position",
                ),
                closing_provided=_coerce_bool(
                    entry.get("closing_provided"),
                    key="entries[].closing_provided",
                ),
                cash_flow=_coerce_decimal(entry.get("cash_flow"), key="entries[].cash_flow"),
                derived_daily_pct=_coerce_decimal(
                    entry.get("derived_daily_pct"),
                    key="entries[].derived_daily_pct",
                ),
            ),
        )
    return out


class AnalyzeLedgerHandler:
    """``analyze_ledger`` — fresh ledger analysis (paid LLM call).

    The gateway is responsible for cache lookup; this handler always
    invokes the LLM. Empty / oversized windows fail fast.
    """

    op = "analyze_ledger"
    schema = PAYLOAD_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: LedgerService | None) -> None:
        self._service = service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        if self._service is None:
            raise QuantError(
                "LLM_FAILED",
                "ledger service is not configured (no API key in env)",
                {"reason": "no_provider"},
            )
        raw_entries = _require_list(args, "entries")
        if len(raw_entries) == 0:
            raise QuantError(
                "INVALID_ARGUMENT",
                "args.entries must contain at least one entry",
                {"key": "entries"},
            )
        if len(raw_entries) > _MAX_WINDOW:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.entries must contain at most {_MAX_WINDOW} entries",
                {"key": "entries", "got": len(raw_entries)},
            )
        entries = _decode_entries(raw_entries)
        result = self._service.analyze(entries)
        return _payload_table(result)
