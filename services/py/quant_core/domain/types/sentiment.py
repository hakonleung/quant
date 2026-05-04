"""Domain types for the news-sentiment module (modules/06-sentiment-analysis.md §4).

All types here are pure: ``frozen=True, slots=True`` dataclasses with no IO,
no logger, no env. They cross between the LLM-output validator
(``services.news_sentiment_service``) and the cache adapter
(``quant_cache.parquet_sentiment_cache``).

Types stay narrow on purpose: anything optional carries an explicit ``None``
default so that the LLM-output mapper can build them in one shot without
post-hoc patching, and the JSON serializer can round-trip them via
``dataclasses.asdict``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Final, Literal

if TYPE_CHECKING:
    from datetime import date, datetime
    from decimal import Decimal


SCHEMA_VERSION: Final[int] = 4
"""Bump on any breaking change to the dataclasses below; the cache adapter
treats older payloads as expired."""


SourceType = Literal["research", "news", "xueqiu", "guba", "industry"]
"""The five source classes the analyst pass is expected to cover (§3.2).
Used in :attr:`StockSentiment.coverage_gaps` to mark which classes the
LLM did not manage to touch in a given run."""

Direction = Literal["positive", "negative", "neutral"]

PriceChange = Literal["price_up", "price_down", "shortage", "destock", "stable"]

PriceHorizon = Literal["spot", "short_term", "mid_term"]

ThemeTrend = Literal["rising", "stable", "fading"]

IndustryDirection = Literal["improving", "stable", "deteriorating"]

MarketPosition = Literal["leader", "challenger", "follower", "niche", "unclear"]
"""Stock's standing inside its product market."""

CompetitorRelation = Literal[
    "domestic_peer",
    "foreign_peer",
    "substitute",
    "upstream",
    "downstream",
]
"""How a competitor relates to the analysed stock."""

ThreatLevel = Literal["high", "medium", "low"]


StyleSignalName = Literal[
    "growth_over_value",
    "value_over_growth",
    "large_cap_outperform",
    "small_cap_outperform",
    "defensive_over_offensive",
    "offensive_over_defensive",
    "high_beta",
    "low_beta",
]


@dataclass(frozen=True, slots=True)
class Insight:
    """A one-sentence claim with direction, confidence and rumor flag."""

    summary: str
    direction: Direction
    confidence: float
    is_rumor: bool


@dataclass(frozen=True, slots=True)
class ThemeTag:
    """A theme this stock currently belongs to, with relevance to the stock.

    ``relevance`` is the LLM's own "how much is this stock _actually_ part of
    the theme" score. The top-1 ``ThemeTag`` of a stock is what the
    multi-stock aggregator uses to assign cluster membership (§4.3)."""

    label: str
    relevance: float
    rationale: str


@dataclass(frozen=True, slots=True)
class ProductInfo:
    """A core product / business line. Revenue share is optional because
    not every disclosure breaks it out."""

    name: str
    revenue_share_pct: float | None = None
    note: str | None = None


@dataclass(frozen=True, slots=True)
class PriceSignal:
    """An observed shift in product pricing / inventory / availability."""

    product: str
    change: PriceChange
    horizon: PriceHorizon
    magnitude: str | None = None


@dataclass(frozen=True, slots=True)
class ResearchTarget:
    """Sell-side rating + target price + implied upside.

    ``target_price`` and ``target_upside_pct`` are :class:`Decimal` because
    they're money / percentages and CLAUDE.md §2.8 forbids ``float`` for
    those. ``url`` always points at the research note's source page.
    """

    broker: str
    url: str
    rating: str | None = None
    target_price: Decimal | None = None
    target_upside_pct: Decimal | None = None
    horizon_months: int | None = None
    report_date: date | None = None


@dataclass(frozen=True, slots=True)
class CompetitorInfo:
    """One identified peer / substitute and how it compares to the stock."""

    name: str
    relation: CompetitorRelation
    threat_level: ThreatLevel
    note: str
    """One-sentence description of overlap, technical gap, customer share."""


@dataclass(frozen=True, slots=True)
class CompetitiveLandscape:
    """Where the stock sits in its market versus rivals (§4.1).

    Structured to be the LLM-friendly counterpart of a Porter-style read:
    market position + named competitors + moats + risks. Always emitted
    when the analysis can support it; ``None`` only if no on-source
    evidence at all is found."""

    market_position: MarketPosition
    summary: str
    competitors: tuple[CompetitorInfo, ...] = ()
    moats: tuple[str, ...] = ()
    risks: tuple[str, ...] = ()
    market_share_pct: float | None = None


@dataclass(frozen=True, slots=True)
class StockSentiment:
    """Full single-stock sentiment payload (§4.1).

    Returned by :meth:`NewsSentimentService.analyze_one` and cached as JSON
    under ``data/sentiment/stock/<asof>/<code>.json``."""

    code: str
    asof: date
    window_days: int
    sentiment_score: float
    """Overall sentiment score in ``[-1.0, 1.0]``."""
    fetched_at: datetime
    schema_version: int = SCHEMA_VERSION
    result: str = ""
    """Raw plain-text analyst write-up returned by the web-search LLM step.

    Step-1 of the analyze_one pipeline asks the search-enabled LLM for a
    free-form analysis; the verbatim reply is stored here. The structured
    fields below are produced by a second flash-model summarisation pass
    over this same text — so ``result`` is the source of truth and the
    other fields are derived views."""
    core_drivers: tuple[Insight, ...] = ()
    m_and_a: tuple[Insight, ...] = ()
    hot_themes: tuple[ThemeTag, ...] = ()
    core_products: tuple[ProductInfo, ...] = ()
    price_signals: tuple[PriceSignal, ...] = ()
    supply_demand: tuple[Insight, ...] = ()
    research_targets: tuple[ResearchTarget, ...] = ()
    competitive_landscape: CompetitiveLandscape | None = None
    coverage_gaps: tuple[SourceType, ...] = ()
    """Source classes the LLM did not manage to touch (e.g. ``("xueqiu",)``)."""
    caveats: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ThemeCluster:
    """Aggregated theme grouping with member stocks (§4.2)."""

    theme_label: str
    member_codes: tuple[str, ...]
    related_industries: tuple[str, ...]
    heat_score: float
    trend: ThemeTrend
    summary: str


@dataclass(frozen=True, slots=True)
class StyleSignal:
    """One closed-vocabulary market-style signal."""

    name: StyleSignalName
    confidence: float
    rationale: str


@dataclass(frozen=True, slots=True)
class MarketTrend:
    """Top-level market view: prose summary + closed-set style flags."""

    summary: str
    style_signals: tuple[StyleSignal, ...] = ()
    caveats: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class IndustryTrend:
    """Per-industry directional read with drivers + risks."""

    industry: str
    summary: str
    direction: IndustryDirection
    drivers: tuple[str, ...] = ()
    risks: tuple[str, ...] = ()
    related_themes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class MarketSentiment:
    """Full multi-stock sentiment payload (§4.2).

    Returned by :meth:`NewsSentimentService.analyze_many` and cached under
    ``data/sentiment/market/<asof>/<sha256_of_codes>.json``."""

    asof: date
    window_days: int
    fetched_at: datetime
    per_stock: dict[str, StockSentiment]
    schema_version: int = SCHEMA_VERSION
    theme_clusters: tuple[ThemeCluster, ...] = ()
    market_trend: MarketTrend = field(
        default_factory=lambda: MarketTrend(summary="", style_signals=(), caveats=())
    )
    industry_trends: tuple[IndustryTrend, ...] = ()
    caveats: tuple[str, ...] = ()
