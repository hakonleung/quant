"""Flight ops for technical analysis (beta).

Two ops mirror the sentiment surface so the gateway / web client can
reuse the cache-then-paid pattern:

* ``get_cached_ta_one`` — cache-only read; never invokes the LLM.
* ``analyze_ta_one``    — fresh analysis (paid LLM call); writes through
  the cache.

Each op returns either an empty Arrow table (cache miss) or one row in
:data:`PAYLOAD_SCHEMA` whose only column is the JSON-encoded
:class:`TaAnalysis`. The JSON tunnel is a deliberate choice — TA
payloads are small, deeply nested, and not amenable to columnar
zero-copy.
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
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.domain.types.ta import TaAnalysis
    from quant_core.ports.clock import Clock
    from quant_core.ports.ta_cache import TaCache
    from quant_core.services.ta_service import TaService


PAYLOAD_SCHEMA: Final[pa.Schema] = pa.schema([("payload_json", pa.string())])


def _require_str(args: Mapping[str, object], key: str) -> str:
    raw = args.get(key)
    if not isinstance(raw, str) or not raw:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a non-empty string",
            {"key": key},
        )
    return raw


def _opt_bool(args: Mapping[str, object], key: str, *, default: bool) -> bool:
    raw = args.get(key)
    if raw is None:
        return default
    if not isinstance(raw, bool):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a bool",
            {"key": key, "got": type(raw).__name__},
        )
    return raw


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


def _payload_table(value: Any) -> pa.Table:
    if value is None:
        return PAYLOAD_SCHEMA.empty_table()
    payload = json.dumps(_normalise(asdict(value)), ensure_ascii=False)
    return pa.Table.from_pylist([{"payload_json": payload}], schema=PAYLOAD_SCHEMA)


class GetCachedTaOneHandler:
    """``get_cached_ta_one`` — never invokes the LLM."""

    op = "get_cached_ta_one"
    schema = PAYLOAD_SCHEMA

    __slots__ = ("_cache", "_clock")

    def __init__(self, cache: TaCache, clock: Clock) -> None:
        self._cache = cache
        self._clock = clock

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        code = _require_str(args, "code")
        asof = self._clock.now().date()
        cached: TaAnalysis | None = self._cache.get(code, asof)
        return _payload_table(cached)


class AnalyzeTaOneHandler:
    """``analyze_ta_one`` — fresh analysis (paid LLM call)."""

    op = "analyze_ta_one"
    schema = PAYLOAD_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: TaService | None) -> None:
        self._service = service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        if self._service is None:
            raise QuantError(
                "LLM_FAILED",
                "ta service is not configured (no API key in env)",
                {"reason": "no_provider"},
            )
        code = _require_str(args, "code")
        bypass_cache = _opt_bool(args, "bypass_cache", default=False)
        result = self._service.analyze_one(code, bypass_cache=bypass_cache)
        return _payload_table(result)
