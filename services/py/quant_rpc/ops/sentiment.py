"""Flight ops for news-sentiment (modules/06-sentiment-analysis.md +
modules/07-frontend.md §4.2).

Four ops are exposed; the gateway maps them to two HTTP verb pairs:

* ``get_cached_stock_sentiment``    — cache-only single-stock read
* ``analyze_one_stock_sentiment``   — fresh single-stock analysis (LLM)
* ``get_cached_market_sentiment``   — cache-only multi-stock read
* ``analyze_many_stock_sentiment``  — fresh multi-stock analysis (LLM)

Each op returns either an empty Arrow table (cache miss) or a single
row in :data:`PAYLOAD_SCHEMA` whose only column is the JSON-encoded
``StockSentiment`` / ``MarketSentiment`` payload. We ride the JSON tunnel
because Flight's strength (zero-copy columnar transport) doesn't apply
here — sentiment is a deeply nested document, not a row set.
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
    from collections.abc import Mapping, Sequence

    from quant_core.domain.types.sentiment import MarketSentiment, StockSentiment
    from quant_core.ports.sentiment_cache import SentimentCache
    from quant_core.services.news_sentiment_service import NewsSentimentService


PAYLOAD_SCHEMA: Final[pa.Schema] = pa.schema([("payload_json", pa.string())])
"""One-column Arrow schema carrying a JSON-encoded sentiment payload."""

_DEFAULT_WINDOW_DAYS: Final[int] = 30
_MAX_CODES: Final[int] = 200


# ---------------------------------------------------------------------------
# arg parsing
# ---------------------------------------------------------------------------


def _require_str(args: "Mapping[str, object]", key: str) -> str:
    raw = args.get(key)
    if not isinstance(raw, str) or not raw:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a non-empty string",
            {"key": key},
        )
    return raw


def _opt_int(args: "Mapping[str, object]", key: str, *, default: int) -> int:
    raw = args.get(key)
    if raw is None:
        return default
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be an int",
            {"key": key, "got": type(raw).__name__},
        )
    return raw


def _opt_bool(args: "Mapping[str, object]", key: str, *, default: bool) -> bool:
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


def _require_codes(args: "Mapping[str, object]") -> "Sequence[str]":
    raw = args.get("codes")
    if not isinstance(raw, list) or len(raw) == 0:
        raise QuantError(
            "INVALID_ARGUMENT",
            "args.codes must be a non-empty list of strings",
        )
    if len(raw) > _MAX_CODES:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.codes too large: {len(raw)} > {_MAX_CODES}",
            {"limit": _MAX_CODES},
        )
    out: list[str] = []
    for i, item in enumerate(raw):
        if not isinstance(item, str) or not item:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.codes[{i}] must be a non-empty string",
                {"index": i},
            )
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# JSON serialisation
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


def _payload_table(value: Any) -> pa.Table:
    if value is None:
        return PAYLOAD_SCHEMA.empty_table()
    payload = json.dumps(_normalise(asdict(value)), ensure_ascii=False)
    return pa.Table.from_pylist([{"payload_json": payload}], schema=PAYLOAD_SCHEMA)


# ---------------------------------------------------------------------------
# handlers — single stock
# ---------------------------------------------------------------------------


class GetCachedStockSentimentHandler:
    """``get_cached_stock_sentiment`` — never invokes the LLM."""

    op = "get_cached_stock_sentiment"
    schema = PAYLOAD_SCHEMA

    __slots__ = ("_cache", "_clock")

    def __init__(self, cache: "SentimentCache", clock: Any) -> None:
        self._cache = cache
        self._clock = clock

    def execute(self, args: "Mapping[str, object]") -> pa.Table:
        code = _require_str(args, "code")
        window_days = _opt_int(args, "window_days", default=_DEFAULT_WINDOW_DAYS)
        asof = self._clock.now().date()
        cached: StockSentiment | None = self._cache.get_stock(code, asof, window_days)
        return _payload_table(cached)


class AnalyzeOneStockSentimentHandler:
    """``analyze_one_stock_sentiment`` — fresh analysis (paid LLM call)."""

    op = "analyze_one_stock_sentiment"
    schema = PAYLOAD_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: "NewsSentimentService | None") -> None:
        self._service = service

    def execute(self, args: "Mapping[str, object]") -> pa.Table:
        if self._service is None:
            raise QuantError(
                "LLM_FAILED",
                "sentiment LLM client is not configured (no API key in env)",
                {"reason": "no_provider"},
            )
        code = _require_str(args, "code")
        window_days = _opt_int(args, "window_days", default=_DEFAULT_WINDOW_DAYS)
        bypass_cache = _opt_bool(args, "bypass_cache", default=False)
        result = self._service.analyze_one(
            code,
            days=window_days,
            bypass_cache=bypass_cache,
        )
        return _payload_table(result)


# ---------------------------------------------------------------------------
# handlers — multi stock (board / sector)
# ---------------------------------------------------------------------------


class GetCachedMarketSentimentHandler:
    """``get_cached_market_sentiment`` — cache-only aggregate read."""

    op = "get_cached_market_sentiment"
    schema = PAYLOAD_SCHEMA

    __slots__ = ("_cache", "_clock")

    def __init__(self, cache: "SentimentCache", clock: Any) -> None:
        self._cache = cache
        self._clock = clock

    def execute(self, args: "Mapping[str, object]") -> pa.Table:
        codes = _require_codes(args)
        window_days = _opt_int(args, "window_days", default=_DEFAULT_WINDOW_DAYS)
        asof = self._clock.now().date()
        cached: MarketSentiment | None = self._cache.get_market(codes, asof, window_days)
        return _payload_table(cached)


class AnalyzeManyStockSentimentHandler:
    """``analyze_many_stock_sentiment`` — fresh aggregate analysis."""

    op = "analyze_many_stock_sentiment"
    schema = PAYLOAD_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: "NewsSentimentService | None") -> None:
        self._service = service

    def execute(self, args: "Mapping[str, object]") -> pa.Table:
        if self._service is None:
            raise QuantError(
                "LLM_FAILED",
                "sentiment LLM client is not configured (no API key in env)",
                {"reason": "no_provider"},
            )
        codes = _require_codes(args)
        window_days = _opt_int(args, "window_days", default=_DEFAULT_WINDOW_DAYS)
        bypass_cache = _opt_bool(args, "bypass_cache", default=False)
        result = self._service.analyze_many(
            codes,
            days=window_days,
            bypass_cache=bypass_cache,
        )
        return _payload_table(result)
