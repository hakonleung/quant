"""News-sentiment service (modules/06-sentiment-analysis.md).

Two public methods:

* :meth:`NewsSentimentService.analyze_one` — single stock, Kimi
  ``$web_search`` driven, results cached for ``asof + 2 days``.
* :meth:`NewsSentimentService.analyze_many` — multi-stock; reuses
  ``analyze_one`` for the per-stock layer, then runs one final LLM
  pass (no web_search) to cluster themes and synthesise market /
  industry trends.

The service is the only place that knows the prompt text. Every other
detail (LLM transport, web_search loop, JSON parsing, cache layout) lives
behind a port.
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date as date_cls
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Final, cast

from quant_core.domain.types.sentiment import (
    SCHEMA_VERSION,
    CompetitiveLandscape,
    CompetitorInfo,
    CompetitorRelation,
    Evidence,
    IndustryDirection,
    IndustryTrend,
    Insight,
    MarketPosition,
    MarketSentiment,
    MarketTrend,
    PriceSignal,
    ProductInfo,
    ResearchTarget,
    SourceType,
    StockSentiment,
    StyleSignal,
    StyleSignalName,
    ThemeCluster,
    ThemeTag,
    ThemeTrend,
    ThreatLevel,
)
from quant_core.errors import QuantError
from quant_core.prompts import (
    build_cluster_system_prompt,
    build_market_synth_system_prompt,
    build_stock_search_system_prompt,
    build_stock_search_user_prompt,
    build_stock_summarize_system_prompt,
    build_stock_summarize_user_prompt,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from quant_core.domain.types.stock import StockMeta
    from quant_core.ports.clock import Clock
    from quant_core.ports.llm_client import LLMClient, WebSearchLLMClient
    from quant_core.ports.sentiment_cache import SentimentCache
    from quant_core.ports.stock_meta_repo import StockMetaRepo


logger = logging.getLogger(__name__)


_SOURCE_TYPES: Final[frozenset[str]] = frozenset(
    ("research", "news", "xueqiu", "guba", "industry")
)
_DIRECTIONS: Final[frozenset[str]] = frozenset(("positive", "negative", "neutral"))
_PRICE_CHANGES: Final[frozenset[str]] = frozenset(
    ("price_up", "price_down", "shortage", "destock", "stable")
)
_PRICE_HORIZONS: Final[frozenset[str]] = frozenset(("spot", "short_term", "mid_term"))
_THEME_TRENDS: Final[frozenset[str]] = frozenset(("rising", "stable", "fading"))
_INDUSTRY_DIRECTIONS: Final[frozenset[str]] = frozenset(
    ("improving", "stable", "deteriorating")
)
_MARKET_POSITIONS: Final[frozenset[str]] = frozenset(
    ("leader", "challenger", "follower", "niche", "unclear")
)
_COMPETITOR_RELATIONS: Final[frozenset[str]] = frozenset(
    ("domestic_peer", "foreign_peer", "substitute", "upstream", "downstream")
)
_THREAT_LEVELS: Final[frozenset[str]] = frozenset(("high", "medium", "low"))
_STYLE_SIGNAL_NAMES: Final[frozenset[str]] = frozenset(
    (
        "growth_over_value",
        "value_over_growth",
        "large_cap_outperform",
        "small_cap_outperform",
        "defensive_over_offensive",
        "offensive_over_defensive",
        "high_beta",
        "low_beta",
    )
)

_DEFAULT_MAX_SEARCHES_PER_STOCK: Final[int] = 8
_DEFAULT_MULTI_STOCK_CONCURRENCY: Final[int] = 8


@dataclass(frozen=True, slots=True)
class NewsSentimentConfig:
    """Tunables for the service. Defaults match modules/06 §3.3 / §6."""

    max_searches_per_stock: int = _DEFAULT_MAX_SEARCHES_PER_STOCK
    multi_stock_concurrency: int = _DEFAULT_MULTI_STOCK_CONCURRENCY


class NewsSentimentService:
    """Two-method news-sentiment surface backed by Kimi web_search + cache."""

    __slots__ = (
        "_aggregator_llm",
        "_cache",
        "_clock",
        "_config",
        "_meta_repo",
        "_search_llm",
    )

    def __init__(
        self,
        *,
        search_llm: WebSearchLLMClient,
        aggregator_llm: LLMClient,
        cache: SentimentCache,
        meta_repo: StockMetaRepo,
        clock: Clock,
        config: NewsSentimentConfig | None = None,
    ) -> None:
        self._search_llm = search_llm
        self._aggregator_llm = aggregator_llm
        self._cache = cache
        self._meta_repo = meta_repo
        self._clock = clock
        self._config = config if config is not None else NewsSentimentConfig()

    # -- public API -------------------------------------------------------

    def analyze_one(
        self,
        code: str,
        *,
        days: int = 30,
        asof: date_cls | None = None,
        bypass_cache: bool = False,
    ) -> StockSentiment:
        """Return the seven-field sentiment payload for one stock.

        Args:
            code: 6-digit A-share code.
            days: Look-back window the LLM is told to consider.
            asof: Reference date; defaults to today (UTC).
            bypass_cache: If True, ignore an existing cached result and
                re-query Kimi.

        Raises:
            QuantError: ``STOCK_NOT_FOUND`` when ``code`` has no metadata
                row; ``LLM_FAILED`` when Kimi cannot produce a parseable
                JSON answer after one retry.
        """
        if days <= 0:
            raise QuantError(
                "INVALID_ARGUMENT",
                "days must be positive",
                {"days": days},
            )
        resolved_asof = asof if asof is not None else self._clock.now().date()
        meta = self._meta_repo.get(code)
        if meta is None:
            raise QuantError(
                "STOCK_NOT_FOUND",
                f"no metadata for code {code}",
                {"code": code},
            )
        if not bypass_cache:
            cached = self._cache.get_stock(code, resolved_asof, days)
            if cached is not None:
                return cached
        result = self._fetch_and_parse_stock(meta, resolved_asof, days)
        self._cache.put_stock(result)
        return result

    def analyze_many(
        self,
        codes: Sequence[str],
        *,
        days: int = 30,
        asof: date_cls | None = None,
        bypass_cache: bool = False,
    ) -> MarketSentiment:
        """Aggregate per-stock payloads + cluster + synthesise trends.

        Per-stock work fans out concurrently up to
        :attr:`NewsSentimentConfig.multi_stock_concurrency`. Failures on
        individual stocks are recorded as caveats; the call as a whole
        succeeds as long as at least one stock returned a payload.
        """
        if not codes:
            raise QuantError(
                "INVALID_ARGUMENT",
                "codes must be non-empty",
                {"codes": list(codes)},
            )
        if days <= 0:
            raise QuantError(
                "INVALID_ARGUMENT",
                "days must be positive",
                {"days": days},
            )
        resolved_asof = asof if asof is not None else self._clock.now().date()
        unique_codes = sorted({c for c in codes if c})
        if not bypass_cache:
            cached = self._cache.get_market(unique_codes, resolved_asof, days)
            if cached is not None:
                return cached
        per_stock, failures = self._gather_per_stock(
            unique_codes, days=days, asof=resolved_asof, bypass_cache=bypass_cache
        )
        caveats: list[str] = [
            f"{code}: {reason}" for code, reason in failures
        ]
        if not per_stock:
            raise QuantError(
                "LLM_FAILED",
                "every per-stock analysis failed in analyze_many",
                {"codes": unique_codes, "failures": failures},
            )
        clusters = self._cluster_themes(per_stock)
        market_trend, industry_trends, agg_caveats = self._synthesise_market(
            per_stock, clusters
        )
        result = MarketSentiment(
            asof=resolved_asof,
            window_days=days,
            fetched_at=self._clock.now(),
            per_stock=per_stock,
            theme_clusters=clusters,
            market_trend=market_trend,
            industry_trends=industry_trends,
            caveats=tuple(caveats + agg_caveats),
        )
        self._cache.put_market(result)
        return result

    # -- per-stock pipeline ----------------------------------------------

    def _gather_per_stock(
        self,
        codes: Sequence[str],
        *,
        days: int,
        asof: date_cls,
        bypass_cache: bool,
    ) -> tuple[dict[str, StockSentiment], list[tuple[str, str]]]:
        per_stock: dict[str, StockSentiment] = {}
        failures: list[tuple[str, str]] = []
        max_workers = max(1, self._config.multi_stock_concurrency)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            future_by_code = {
                pool.submit(
                    self.analyze_one,
                    code,
                    days=days,
                    asof=asof,
                    bypass_cache=bypass_cache,
                ): code
                for code in codes
            }
            for future, code in future_by_code.items():
                try:
                    per_stock[code] = future.result()
                except QuantError as exc:
                    logger.warning(
                        "analyze_one_failed",
                        extra={
                            "code": code,
                            "error_code": exc.code,
                            "error_message": str(exc),
                        },
                    )
                    failures.append((code, f"{exc.code}: {exc}"))
        return per_stock, failures

    def _fetch_and_parse_stock(
        self,
        meta: StockMeta,
        asof: date_cls,
        days: int,
    ) -> StockSentiment:
        """Two-step pipeline: web-search analyst pass → flash summariser.

        1. ``search_llm.complete_with_web_search`` returns plain analyst
           text; the verbatim reply is preserved on
           ``StockSentiment.result``.
        2. ``aggregator_llm.complete_json`` (flash model) reads that text
           and emits structured fields (drivers / themes / etc.) with no
           per-claim evidence requirement — the analyst pass already
           produced the source-attributed write-up.
        """
        research_text = self._search_llm.complete_with_web_search(
            system=build_stock_search_system_prompt(),
            user=build_stock_search_user_prompt(meta=meta, asof=asof, days=days),
            max_searches=self._config.max_searches_per_stock,
        )
        return self._summarise_research_text(
            research_text=research_text,
            meta=meta,
            asof=asof,
            days=days,
        )

    def _summarise_research_text(
        self,
        *,
        research_text: str,
        meta: StockMeta,
        asof: date_cls,
        days: int,
    ) -> StockSentiment:
        system = build_stock_summarize_system_prompt()
        user = build_stock_summarize_user_prompt(
            meta=meta, asof=asof, days=days, research_text=research_text
        )
        last_error: str | None = None
        for attempt in range(2):
            raw = self._aggregator_llm.complete_json(system=system, user=user)
            try:
                payload = _parse_json_object(raw)
                return _build_stock_sentiment(
                    payload,
                    code=meta.code,
                    asof=asof,
                    window_days=days,
                    fetched_at=self._clock.now(),
                    result=research_text,
                )
            except QuantError as exc:
                last_error = f"{exc.code}: {exc}"
                logger.warning(
                    "stock_sentiment_parse_failed",
                    extra={
                        "attempt": attempt,
                        "code": meta.code,
                        "error": last_error,
                        "raw_snippet": raw[:500],
                    },
                )
                user = (
                    f"{user}\n\nYour previous JSON failed validation: {exc}\n"
                    "Emit a corrected JSON only. Do not repeat the same mistake."
                )
        raise QuantError(
            "LLM_FAILED",
            f"could not summarise research text for {meta.code}: {last_error}",
            {"code": meta.code, "last_error": last_error or ""},
        )

    # -- aggregation ------------------------------------------------------

    def _cluster_themes(
        self,
        per_stock: dict[str, StockSentiment],
    ) -> tuple[ThemeCluster, ...]:
        # Map every stock to its top-1 theme; stocks with no themes do not
        # contribute to clustering.
        memberships: list[tuple[str, ThemeTag]] = []
        for code, stock in per_stock.items():
            if not stock.hot_themes:
                continue
            top = max(stock.hot_themes, key=lambda t: t.relevance)
            memberships.append((code, top))
        if not memberships:
            return ()

        prompt_payload = {
            "stocks": [
                {
                    "code": code,
                    "theme_label": tag.label,
                    "rationale": tag.rationale,
                    "relevance": tag.relevance,
                }
                for code, tag in memberships
            ]
        }
        system = build_cluster_system_prompt()
        user = (
            "Group these stocks by the most relevant underlying theme. "
            "Merge near-synonymous theme labels. Return JSON with a single "
            "key 'clusters' as described in the system prompt.\n"
            f"INPUT:\n{json.dumps(prompt_payload, ensure_ascii=False)}"
        )
        raw = self._aggregator_llm.complete_json(system=system, user=user)
        try:
            payload = _parse_json_object(raw)
        except QuantError:
            return _fallback_clusters(per_stock, memberships)
        clusters_raw = payload.get("clusters")
        if not isinstance(clusters_raw, list):
            return _fallback_clusters(per_stock, memberships)
        out: list[ThemeCluster] = []
        for entry in clusters_raw:
            cluster = _build_theme_cluster(entry, per_stock)
            if cluster is not None:
                out.append(cluster)
        if not out:
            return _fallback_clusters(per_stock, memberships)
        return tuple(out)

    def _synthesise_market(
        self,
        per_stock: dict[str, StockSentiment],
        clusters: tuple[ThemeCluster, ...],
    ) -> tuple[MarketTrend, tuple[IndustryTrend, ...], list[str]]:
        if not per_stock:
            empty = MarketTrend(summary="", style_signals=(), caveats=())
            return empty, (), []
        prompt_payload = {
            "stocks": [
                {
                    "code": s.code,
                    "sentiment_score": s.sentiment_score,
                    "top_theme": s.hot_themes[0].label if s.hot_themes else None,
                    "core_drivers": [d.summary for d in s.core_drivers],
                }
                for s in per_stock.values()
            ],
            "clusters": [
                {
                    "label": c.theme_label,
                    "members": list(c.member_codes),
                    "industries": list(c.related_industries),
                    "trend": c.trend,
                }
                for c in clusters
            ],
        }
        system = build_market_synth_system_prompt()
        user = (
            "Synthesise the market-level and industry-level views from the "
            "input. Return JSON exactly as described in the system prompt.\n"
            f"INPUT:\n{json.dumps(prompt_payload, ensure_ascii=False)}"
        )
        raw = self._aggregator_llm.complete_json(system=system, user=user)
        try:
            payload = _parse_json_object(raw)
        except QuantError as exc:
            empty = MarketTrend(
                summary="",
                style_signals=(),
                caveats=(f"market_synth failed: {exc}",),
            )
            return empty, (), [f"market_synth: {exc}"]
        market_trend = _build_market_trend(payload.get("market_trend"))
        industry_trends = _build_industry_trends(payload.get("industry_trends"))
        return market_trend, industry_trends, []


# -- output validation -------------------------------------------------------


def _parse_json_object(raw: str) -> dict[str, object]:
    text = raw.strip()
    if text.startswith("```"):
        # Strip markdown fences if the model added them.
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
            f"output is not valid JSON: {exc.msg}",
            {"snippet": raw[:200]},
        ) from exc
    if not isinstance(payload, dict):
        raise QuantError("LLM_FAILED", "output is not a JSON object")
    return payload


def _build_stock_sentiment(
    payload: dict[str, object],
    *,
    code: str,
    asof: date_cls,
    window_days: int,
    fetched_at: datetime,
    result: str = "",
) -> StockSentiment:
    sentiment_score = payload.get("sentiment_score")
    if not isinstance(sentiment_score, (int, float)):
        raise QuantError("LLM_FAILED", "missing or invalid 'sentiment_score'")
    score = max(-1.0, min(1.0, float(sentiment_score)))

    return StockSentiment(
        code=code,
        asof=asof,
        window_days=window_days,
        sentiment_score=score,
        fetched_at=fetched_at,
        schema_version=SCHEMA_VERSION,
        result=result,
        core_drivers=tuple(_iter_insights(payload.get("core_drivers"))),
        m_and_a=tuple(_iter_insights(payload.get("m_and_a"))),
        hot_themes=tuple(_iter_themes(payload.get("hot_themes"))),
        core_products=tuple(_iter_products(payload.get("core_products"))),
        price_signals=tuple(_iter_price_signals(payload.get("price_signals"))),
        supply_demand=tuple(_iter_insights(payload.get("supply_demand"))),
        research_targets=tuple(_iter_research_targets(payload.get("research_targets"))),
        competitive_landscape=_build_competitive_landscape(payload.get("competitive_landscape")),
        coverage_gaps=tuple(_iter_coverage_gaps(payload.get("coverage_gaps"))),
        caveats=tuple(_iter_strings(payload.get("caveats"))),
    )


def _iter_insights(raw: object) -> list[Insight]:
    if not isinstance(raw, list):
        return []
    out: list[Insight] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        evidence = _build_evidence_list(entry.get("evidence"))
        direction = entry.get("direction")
        if direction not in _DIRECTIONS:
            continue
        confidence = _coerce_unit_float(entry.get("confidence"))
        if confidence is None:
            continue
        summary = entry.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            continue
        out.append(
            Insight(
                summary=summary.strip(),
                direction=direction,
                confidence=confidence,
                is_rumor=bool(entry.get("is_rumor", False)),
                evidence=evidence,
            )
        )
    return out


def _iter_themes(raw: object) -> list[ThemeTag]:
    if not isinstance(raw, list):
        return []
    out: list[ThemeTag] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        evidence = _build_evidence_list(entry.get("evidence"))
        relevance = _coerce_unit_float(entry.get("relevance"))
        if relevance is None:
            continue
        label = entry.get("label")
        rationale = entry.get("rationale")
        if not isinstance(label, str) or not label.strip():
            continue
        if not isinstance(rationale, str):
            rationale = ""
        out.append(
            ThemeTag(
                label=label.strip(),
                relevance=relevance,
                rationale=rationale,
                evidence=evidence,
            )
        )
    out.sort(key=lambda t: t.relevance, reverse=True)
    return out


def _iter_products(raw: object) -> list[ProductInfo]:
    if not isinstance(raw, list):
        return []
    out: list[ProductInfo] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        share = entry.get("revenue_share_pct")
        share_value: float | None = None
        if isinstance(share, (int, float)):
            share_value = float(share)
        note = entry.get("note") if isinstance(entry.get("note"), str) else None
        out.append(
            ProductInfo(
                name=name.strip(),
                revenue_share_pct=share_value,
                note=note,
            )
        )
    return out


def _iter_price_signals(raw: object) -> list[PriceSignal]:
    if not isinstance(raw, list):
        return []
    out: list[PriceSignal] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        evidence = _build_evidence_list(entry.get("evidence"))
        change = entry.get("change")
        horizon = entry.get("horizon")
        product = entry.get("product")
        if change not in _PRICE_CHANGES:
            continue
        if horizon not in _PRICE_HORIZONS:
            continue
        if not isinstance(product, str) or not product.strip():
            continue
        magnitude = entry.get("magnitude") if isinstance(entry.get("magnitude"), str) else None
        out.append(
            PriceSignal(
                product=product.strip(),
                change=change,
                horizon=horizon,
                evidence=evidence,
                magnitude=magnitude,
            )
        )
    return out


def _iter_research_targets(raw: object) -> list[ResearchTarget]:
    if not isinstance(raw, list):
        return []
    out: list[ResearchTarget] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        broker = entry.get("broker")
        url = entry.get("url")
        if not isinstance(broker, str) or not broker.strip():
            continue
        if not isinstance(url, str) or not url.strip():
            continue
        out.append(
            ResearchTarget(
                broker=broker.strip(),
                url=url.strip(),
                rating=entry.get("rating") if isinstance(entry.get("rating"), str) else None,
                target_price=_coerce_decimal(entry.get("target_price")),
                target_upside_pct=_coerce_decimal(entry.get("target_upside_pct")),
                horizon_months=_coerce_int(entry.get("horizon_months")),
                report_date=_coerce_date(entry.get("report_date")),
            )
        )
    return out


def _build_competitive_landscape(raw: object) -> CompetitiveLandscape | None:
    if raw is None or not isinstance(raw, dict):
        return None
    position_raw = raw.get("market_position")
    if position_raw not in _MARKET_POSITIONS:
        return None
    summary_raw = raw.get("summary")
    summary = summary_raw.strip() if isinstance(summary_raw, str) else ""
    competitors = _iter_competitors(raw.get("competitors"))
    moats_raw = raw.get("moats", [])
    moats = (
        tuple(s for s in moats_raw if isinstance(s, str) and s.strip())
        if isinstance(moats_raw, list)
        else ()
    )
    risks_raw = raw.get("risks", [])
    risks = (
        tuple(s for s in risks_raw if isinstance(s, str) and s.strip())
        if isinstance(risks_raw, list)
        else ()
    )
    evidence = _build_evidence_list(raw.get("evidence"))
    share_raw = raw.get("market_share_pct")
    share: float | None
    if isinstance(share_raw, (int, float)) and not isinstance(share_raw, bool):
        share = float(share_raw)
    else:
        share = None
    return CompetitiveLandscape(
        market_position=cast("MarketPosition", position_raw),
        summary=summary,
        competitors=competitors,
        moats=moats,
        risks=risks,
        evidence=evidence,
        market_share_pct=share,
    )


def _iter_competitors(raw: object) -> tuple[CompetitorInfo, ...]:
    if not isinstance(raw, list):
        return ()
    out: list[CompetitorInfo] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        relation_raw = entry.get("relation")
        if relation_raw not in _COMPETITOR_RELATIONS:
            continue
        threat_raw = entry.get("threat_level")
        if threat_raw not in _THREAT_LEVELS:
            continue
        note_raw = entry.get("note")
        note = note_raw.strip() if isinstance(note_raw, str) else ""
        evidence = _build_evidence_list(entry.get("evidence"))
        out.append(
            CompetitorInfo(
                name=name.strip(),
                relation=cast("CompetitorRelation", relation_raw),
                threat_level=cast("ThreatLevel", threat_raw),
                note=note,
                evidence=evidence,
            )
        )
    return tuple(out)


def _iter_coverage_gaps(raw: object) -> list[SourceType]:
    if not isinstance(raw, list):
        return []
    out: list[SourceType] = []
    for entry in raw:
        if isinstance(entry, str) and entry in _SOURCE_TYPES:
            out.append(cast("SourceType", entry))
    return out


def _iter_strings(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [s for s in raw if isinstance(s, str)]


def _build_evidence_list(raw: object) -> tuple[Evidence, ...]:
    if not isinstance(raw, list):
        return ()
    out: list[Evidence] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        source_type = entry.get("source_type")
        quoted_text = entry.get("quoted_text")
        url = entry.get("url")
        if source_type not in _SOURCE_TYPES:
            continue
        if not isinstance(quoted_text, str) or not quoted_text.strip():
            continue
        if not isinstance(url, str) or not url.strip():
            continue
        out.append(
            Evidence(
                source_type=cast("SourceType", source_type),
                quoted_text=quoted_text.strip(),
                url=url.strip(),
                published_at=_coerce_date(entry.get("published_at")),
            )
        )
    return tuple(out)


def _coerce_unit_float(raw: object) -> float | None:
    if not isinstance(raw, (int, float)):
        return None
    value = float(raw)
    if value < 0.0 or value > 1.0:
        return max(0.0, min(1.0, value))
    return value


def _coerce_decimal(raw: object) -> Decimal | None:
    if raw is None:
        return None
    if isinstance(raw, Decimal):
        return raw
    try:
        return Decimal(str(raw))
    except (InvalidOperation, ValueError):
        return None


def _coerce_int(raw: object) -> int | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        return int(raw)
    return None


def _coerce_date(raw: object) -> date_cls | None:
    if raw is None:
        return None
    if isinstance(raw, date_cls):
        return raw
    if isinstance(raw, str):
        try:
            return date_cls.fromisoformat(raw)
        except ValueError:
            return None
    return None


def _build_theme_cluster(
    raw: object,
    per_stock: dict[str, StockSentiment],
) -> ThemeCluster | None:
    if not isinstance(raw, dict):
        return None
    label = raw.get("theme_label")
    if not isinstance(label, str) or not label.strip():
        return None
    member_codes_raw = raw.get("member_codes")
    if not isinstance(member_codes_raw, list):
        return None
    members = tuple(c for c in member_codes_raw if isinstance(c, str) and c in per_stock)
    if not members:
        return None
    industries_raw = raw.get("related_industries", [])
    industries = tuple(
        i for i in industries_raw if isinstance(i, str)
    ) if isinstance(industries_raw, list) else ()
    heat = _coerce_unit_float(raw.get("heat_score"))
    if heat is None:
        # Heat score is open-ended in the schema; fall back to a rough
        # proxy if the model emitted something unparseable.
        heat = float(len(members))
    trend_raw = raw.get("trend")
    trend: ThemeTrend = (
        cast("ThemeTrend", trend_raw) if trend_raw in _THEME_TRENDS else "stable"
    )
    summary_raw = raw.get("summary")
    summary = summary_raw if isinstance(summary_raw, str) else ""
    top_evidence: list[Evidence] = []
    for code in members:
        stock = per_stock[code]
        for tag in stock.hot_themes:
            if tag.label == label or tag.label.lower() == label.lower():
                top_evidence.extend(tag.evidence)
                break
    # Cap at 3 to keep the payload small.
    return ThemeCluster(
        theme_label=label.strip(),
        member_codes=members,
        related_industries=industries,
        heat_score=heat,
        trend=trend,
        summary=summary,
        top_evidence=tuple(top_evidence[:3]),
    )


def _fallback_clusters(
    per_stock: dict[str, StockSentiment],
    memberships: list[tuple[str, ThemeTag]],
) -> tuple[ThemeCluster, ...]:
    """Used when the aggregator LLM call fails or returns garbage.

    Groups stocks by exact ``label`` match — no merging — so the user
    still sees something coherent even if the LLM melt-down lost us the
    deduplication step.
    """
    by_label: dict[str, list[tuple[str, ThemeTag]]] = {}
    for code, tag in memberships:
        by_label.setdefault(tag.label, []).append((code, tag))
    out: list[ThemeCluster] = []
    for label, entries in by_label.items():
        members = tuple(c for c, _ in entries)
        evidence_pool: list[Evidence] = []
        for _, tag in entries:
            evidence_pool.extend(tag.evidence)
        out.append(
            ThemeCluster(
                theme_label=label,
                member_codes=members,
                related_industries=(),
                heat_score=float(len(members)),
                trend="stable",
                summary="",
                top_evidence=tuple(evidence_pool[:3]),
            )
        )
    out.sort(key=lambda c: c.heat_score, reverse=True)
    return tuple(out)


def _build_market_trend(raw: object) -> MarketTrend:
    if not isinstance(raw, dict):
        return MarketTrend(summary="", style_signals=(), caveats=())
    summary_raw = raw.get("summary")
    summary = summary_raw if isinstance(summary_raw, str) else ""
    signals_raw = raw.get("style_signals")
    signals: list[StyleSignal] = []
    if isinstance(signals_raw, list):
        for entry in signals_raw:
            if not isinstance(entry, dict):
                continue
            name_raw = entry.get("name")
            if name_raw not in _STYLE_SIGNAL_NAMES:
                continue
            confidence = _coerce_unit_float(entry.get("confidence"))
            if confidence is None:
                continue
            rationale_raw = entry.get("rationale")
            rationale = rationale_raw if isinstance(rationale_raw, str) else ""
            signals.append(
                StyleSignal(
                    name=cast("StyleSignalName", name_raw),
                    confidence=confidence,
                    rationale=rationale,
                )
            )
    caveats_raw = raw.get("caveats")
    caveats = (
        tuple(s for s in caveats_raw if isinstance(s, str))
        if isinstance(caveats_raw, list)
        else ()
    )
    return MarketTrend(summary=summary, style_signals=tuple(signals), caveats=caveats)


def _build_industry_trends(raw: object) -> tuple[IndustryTrend, ...]:
    if not isinstance(raw, list):
        return ()
    out: list[IndustryTrend] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        industry = entry.get("industry")
        summary = entry.get("summary")
        direction = entry.get("direction")
        if not isinstance(industry, str) or not industry.strip():
            continue
        if not isinstance(summary, str):
            summary = ""
        if direction not in _INDUSTRY_DIRECTIONS:
            continue
        drivers = entry.get("drivers", [])
        risks = entry.get("risks", [])
        themes = entry.get("related_themes", [])
        out.append(
            IndustryTrend(
                industry=industry.strip(),
                summary=summary,
                direction=cast("IndustryDirection", direction),
                drivers=(
                    tuple(d for d in drivers if isinstance(d, str))
                    if isinstance(drivers, list)
                    else ()
                ),
                risks=(
                    tuple(r for r in risks if isinstance(r, str))
                    if isinstance(risks, list)
                    else ()
                ),
                related_themes=(
                    tuple(t for t in themes if isinstance(t, str))
                    if isinstance(themes, list)
                    else ()
                ),
            )
        )
    return tuple(out)
