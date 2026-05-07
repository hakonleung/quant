"""Technical-analysis service (beta).

Single public method :meth:`TaService.analyze_one`:

1. Look up cache (unless ``bypass_cache=True``); fresh hit → return.
2. Read up to 90 daily bars (qfq prices + MAs) from
   :class:`KlineService`.
3. Render the prompts and call the chained LLM
   (:class:`FallbackLlmClient`) to get JSON back.
4. Validate + decode → :class:`TaAnalysis`.
5. Write through the cache.

Step 3 is the only paid / slow step. Step 1's miss + step 2's fast Parquet
read keep the bare cached path under 100ms. The LLM client is provided
from outside via the port — the service does not know about Kimi /
fallback specifics.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Final, cast

from quant_cache.kline_schema import daily_bar_from_row

from quant_core.domain.types.ta import (
    TaAnalysis,
    TaLevel,
    TaTrend,
)
from quant_core.errors import QuantError
from quant_core.prompts import build_ta_system_prompt, build_ta_user_prompt

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import date as date_cls
    from datetime import datetime

    from quant_core.domain.types.kline import DailyBar
    from quant_core.domain.types.stock import StockMeta
    from quant_core.domain.types.ta import TaLevelStrength, TaTrendDirection
    from quant_core.ports.clock import Clock
    from quant_core.ports.llm_client import LLMClient
    from quant_core.ports.stock_meta_repo import StockMetaRepo
    from quant_core.ports.ta_cache import TaCache
    from quant_core.services.kline_service import KlineService


logger = logging.getLogger(__name__)


_DEFAULT_BARS_WINDOW: Final[int] = 90
_MAX_LEVELS: Final[int] = 5
_MAX_PATTERNS: Final[int] = 8
_LEVEL_STRENGTHS: Final[frozenset[str]] = frozenset({"weak", "medium", "strong"})
_TREND_DIRECTIONS: Final[frozenset[str]] = frozenset({"up", "down", "sideways"})


@dataclass(frozen=True, slots=True)
class TaServiceConfig:
    """Tunables. ``bars_window`` is capped to 90 by spec; lowering it
    only makes sense in tests where 90 bars is overkill."""

    bars_window: int = _DEFAULT_BARS_WINDOW


class TaService:
    """Pure-price-action AI technical analysis with cache + LLM fallback."""

    __slots__ = ("_cache", "_clock", "_config", "_kline", "_llm", "_meta_repo")

    def __init__(
        self,
        *,
        llm: LLMClient,
        kline_service: KlineService,
        cache: TaCache,
        meta_repo: StockMetaRepo,
        clock: Clock,
        config: TaServiceConfig | None = None,
    ) -> None:
        self._llm = llm
        self._kline = kline_service
        self._cache = cache
        self._meta_repo = meta_repo
        self._clock = clock
        self._config = config if config is not None else TaServiceConfig()

    def analyze_one(
        self,
        code: str,
        *,
        asof: date_cls | None = None,
        bypass_cache: bool = False,
    ) -> TaAnalysis:
        """Return a ``TaAnalysis`` for ``code``.

        Args:
            code: 6-digit A-share code.
            asof: Reference trading day; defaults to the latest stored
                bar's date when omitted (so the cache key follows the
                data, not the wall clock).
            bypass_cache: If True, skip the read-side cache lookup.

        Raises:
            QuantError: ``STOCK_NOT_FOUND`` when meta is missing;
                ``KLINE_DATA_MISSING`` when no bars are stored;
                ``LLM_FAILED`` when the chained LLM call fails or its
                output is not valid JSON.
        """
        meta = self._meta_repo.get(code)
        if meta is None:
            raise QuantError(
                "STOCK_NOT_FOUND",
                f"no metadata for code {code}",
                {"code": code},
            )
        bars = self._read_bars(code)
        if not bars:
            raise QuantError(
                "KLINE_DATA_MISSING",
                f"no kline bars for code {code}",
                {"code": code},
            )
        resolved_asof = asof if asof is not None else bars[-1].trade_date
        if not bypass_cache:
            cached = self._cache.get(code, resolved_asof)
            if cached is not None:
                return cached

        payload = self._call_llm(meta=meta, asof=resolved_asof, bars=bars)
        provider = getattr(self._llm, "name", "")
        result = _build_ta_analysis(
            payload,
            code=code,
            asof=resolved_asof,
            bars_count=len(bars),
            fetched_at_naive=self._clock.now(),
            provider=provider if isinstance(provider, str) else "",
        )
        self._cache.put(result)
        return result

    # -- internals ------------------------------------------------------

    def _read_bars(self, code: str) -> list[DailyBar]:
        table = self._kline.get_last_n(code, self._config.bars_window)
        if table.num_rows == 0:
            return []
        rows = table.to_pylist()
        return [daily_bar_from_row(row) for row in rows]

    def _call_llm(
        self,
        *,
        meta: StockMeta,
        asof: date_cls,
        bars: Sequence[DailyBar],
    ) -> dict[str, object]:
        system = build_ta_system_prompt()
        user = build_ta_user_prompt(meta=meta, asof=asof, bars=bars)
        raw = self._llm.complete_json(system=system, user=user)
        return _parse_json_object(raw)


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
            text = text[: -3]
        text = text.strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise QuantError(
            "LLM_FAILED",
            f"ta output is not valid JSON: {exc.msg}",
            {"snippet": raw[:200]},
        ) from exc
    if not isinstance(payload, dict):
        raise QuantError("LLM_FAILED", "ta output is not a JSON object")
    return payload


def _build_ta_analysis(
    payload: dict[str, object],
    *,
    code: str,
    asof: date_cls,
    bars_count: int,
    fetched_at_naive: datetime,
    provider: str,
) -> TaAnalysis:
    support = _decode_levels(payload.get("support_levels"))
    resistance = _decode_levels(payload.get("resistance_levels"))
    trend = _decode_trend(payload.get("trend"))
    patterns = _decode_string_list(payload.get("patterns"), limit=_MAX_PATTERNS)
    caveats = _decode_string_list(payload.get("caveats"), limit=_MAX_PATTERNS)
    return TaAnalysis(
        code=code,
        asof=asof,
        bars_count=bars_count,
        support_levels=support,
        resistance_levels=resistance,
        trend=trend,
        patterns=patterns,
        caveats=caveats,
        fetched_at=fetched_at_naive,
        provider=provider,
    )


def _decode_levels(raw: object) -> tuple[TaLevel, ...]:
    if not isinstance(raw, list):
        return ()
    out: list[TaLevel] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        price = _coerce_decimal(entry.get("price"))
        if price is None:
            continue
        strength_raw = entry.get("strength")
        if strength_raw not in _LEVEL_STRENGTHS:
            continue
        reason_raw = entry.get("reason")
        reason = reason_raw.strip() if isinstance(reason_raw, str) else ""
        # ``in _LEVEL_STRENGTHS`` narrows the runtime value, but mypy
        # cannot see the relationship — cast to the closed literal here.
        strength = cast("TaLevelStrength", strength_raw)
        out.append(TaLevel(price=price, strength=strength, reason=reason))
        if len(out) >= _MAX_LEVELS:
            break
    return tuple(out)


def _decode_trend(raw: object) -> TaTrend:
    if not isinstance(raw, dict):
        raise QuantError("LLM_FAILED", "ta output missing 'trend' object")
    direction_raw = raw.get("direction")
    if direction_raw not in _TREND_DIRECTIONS:
        raise QuantError(
            "LLM_FAILED",
            "ta trend.direction must be up/down/sideways",
            {"got": str(direction_raw)},
        )
    direction = cast("TaTrendDirection", direction_raw)
    horizon = _coerce_int(raw.get("horizon_days"))
    if horizon is None or horizon <= 0:
        raise QuantError(
            "LLM_FAILED",
            "ta trend.horizon_days must be a positive integer",
            {"got": str(raw.get("horizon_days"))},
        )
    confidence = _coerce_unit_float(raw.get("confidence"))
    if confidence is None:
        raise QuantError(
            "LLM_FAILED",
            "ta trend.confidence must be a number in [0,1]",
            {"got": str(raw.get("confidence"))},
        )
    rationale_raw = raw.get("rationale")
    rationale = rationale_raw.strip() if isinstance(rationale_raw, str) else ""
    return TaTrend(
        direction=direction,
        horizon_days=horizon,
        confidence=confidence,
        rationale=rationale,
    )


def _decode_string_list(raw: object, *, limit: int) -> tuple[str, ...]:
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
        if len(out) >= limit:
            break
    return tuple(out)


def _coerce_decimal(raw: object) -> Decimal | None:
    if isinstance(raw, Decimal):
        return raw
    if isinstance(raw, bool):
        # bool is an int subclass — reject explicitly.
        return None
    if isinstance(raw, (int, float, str)):
        try:
            return Decimal(str(raw))
        except (InvalidOperation, ValueError):
            return None
    return None


def _coerce_int(raw: object) -> int | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float) and raw.is_integer():
        return int(raw)
    if isinstance(raw, str):
        try:
            return int(raw)
        except ValueError:
            return None
    return None


def _coerce_unit_float(raw: object) -> float | None:
    if isinstance(raw, bool):
        return None
    if not isinstance(raw, (int, float, str)):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value < 0.0 or value > 1.0:
        return max(0.0, min(1.0, value))
    return value
