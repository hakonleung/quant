"""Unit tests for :class:`NewsSentimentService`.

Covers the two-step single-stock pipeline (web-search analyst pass +
flash summariser), the multi-stock fan-out + cluster/synth aggregation,
boundary errors, the ``asof + 7 days`` cache reuse, and the LLM-output
retry. The web-search and aggregator clients are exercised through fakes;
their wiring is tested in their own modules.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING

import pytest
from quant_cache.parquet_sentiment_cache import ParquetSentimentCache
from quant_core.domain.types.sentiment import (
    MarketSentiment,
    StockSentiment,
)
from quant_core.errors import QuantError
from quant_core.services.news_sentiment_service import (
    NewsSentimentConfig,
    NewsSentimentService,
)

from tests._util.clock import FrozenClock
from tests._util.stock_meta_fixtures import SEED, make_meta

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence
    from pathlib import Path

    from quant_core.domain.types.stock import StockMeta


# -- fakes -------------------------------------------------------------------


class _FakeMetaRepo:
    def __init__(self, items: Iterable[StockMeta]) -> None:
        self._by_code = {m.code: m for m in items}

    def upsert_many(self, items: Iterable[StockMeta]) -> None:
        for m in items:
            self._by_code[m.code] = m

    def get(self, code: str) -> StockMeta | None:
        return self._by_code.get(code)

    def get_many(self, codes: Sequence[str]) -> list[StockMeta]:
        return [self._by_code[c] for c in codes if c in self._by_code]

    def list_by_industry(self, sw_l2: str) -> list[StockMeta]:
        return [m for m in self._by_code.values() if sw_l2 in m.industries]

    def list_all(self) -> list[StockMeta]:
        return list(self._by_code.values())


class _ScriptedSearchLLM:
    """Returns successive plain-text analyst replies from ``responses``.

    Each call to ``complete_with_web_search`` pops one item; the call
    arguments are stashed on ``calls`` for assertions. If the script is
    exhausted, the last entry repeats — keeps tests resilient when the
    service retries internally.
    """

    name: str = "fake-search"

    def __init__(self, responses: list[str]) -> None:
        self._responses = responses
        self.calls: list[dict[str, object]] = []

    def complete_with_web_search(
        self, *, system: str, user: str, max_searches: int
    ) -> str:
        self.calls.append({"system": system, "user": user, "max_searches": max_searches})
        if len(self._responses) > 1:
            return self._responses.pop(0)
        return self._responses[0]


class _ScriptedAggregatorLLM:
    name: str = "fake-aggregator"

    def __init__(self, responses: list[str]) -> None:
        self._responses = responses
        self.calls: list[dict[str, str]] = []

    def complete_json(self, *, system: str, user: str) -> str:
        self.calls.append({"system": system, "user": user})
        if len(self._responses) > 1:
            return self._responses.pop(0)
        return self._responses[0]


# -- prompt fixtures ---------------------------------------------------------


_RESEARCH_TEXT_MAOTAI = "贵州茅台（600519）研究纪要：高端白酒动销改善，批价稳定。"
_RESEARCH_TEXT_WULIANGYE = "五粮液（000858）研究纪要：跟随茅台上涨。"


def _maotai_payload(score: float = 0.6) -> dict[str, object]:
    return {
        "core_drivers": [
            {
                "summary": "高端白酒动销改善",
                "direction": "positive",
                "confidence": 0.7,
                "is_rumor": False,
            }
        ],
        "m_and_a": [],
        "hot_themes": [
            {
                "label": "高端白酒",
                "relevance": 0.9,
                "rationale": "茅台是核心标的",
            }
        ],
        "core_products": [
            {"name": "飞天茅台", "revenue_share_pct": 80.0, "note": None}
        ],
        "price_signals": [
            {
                "product": "飞天茅台",
                "change": "stable",
                "horizon": "spot",
                "magnitude": None,
            }
        ],
        "supply_demand": [],
        "research_targets": [
            {
                "broker": "中金",
                "url": "https://example.com/r/2",
                "rating": "买入",
                "target_price": 2000.0,
                "target_upside_pct": 25.0,
                "horizon_months": 12,
                "report_date": "2026-04-15",
            }
        ],
        "sentiment_score": score,
        "coverage_gaps": ["xueqiu"],
        "caveats": [],
    }


def _wuliangye_payload() -> dict[str, object]:
    payload = _maotai_payload(score=0.4)
    payload["hot_themes"] = [
        {
            "label": "高端白酒概念",
            "relevance": 0.85,
            "rationale": "五粮液同属高端白酒板块",
        }
    ]
    return payload


def _cluster_payload() -> dict[str, object]:
    return {
        "clusters": [
            {
                "theme_label": "高端白酒",
                "member_codes": ["600519", "000858"],
                "related_industries": ["食品饮料"],
                "heat_score": 0.9,
                "trend": "rising",
                "summary": "高端白酒板块整体走强",
            }
        ]
    }


def _market_payload() -> dict[str, object]:
    return {
        "market_trend": {
            "summary": "消费板块阶段性占优",
            "style_signals": [
                {
                    "name": "value_over_growth",
                    "confidence": 0.6,
                    "rationale": "消费白马整体跑赢成长股",
                }
            ],
            "caveats": [],
        },
        "industry_trends": [
            {
                "industry": "食品饮料",
                "summary": "白酒动销改善",
                "direction": "improving",
                "drivers": ["批价企稳"],
                "risks": ["库存压力"],
                "related_themes": ["高端白酒"],
            }
        ],
    }


# -- tests -------------------------------------------------------------------


_NOW = datetime(2026, 5, 1, 9, 30, tzinfo=UTC)
_TODAY = _NOW.date()


def _build_cache(tmp_path: Path, clock: FrozenClock) -> ParquetSentimentCache:
    """Real per-code/per-hash parquet — same shape as production."""
    return ParquetSentimentCache(tmp_path / "sentiment", clock)


@pytest.fixture
def cache(tmp_path: Path) -> ParquetSentimentCache:
    return _build_cache(tmp_path, FrozenClock(_NOW))


@pytest.fixture
def meta_repo() -> _FakeMetaRepo:
    return _FakeMetaRepo(SEED)


@pytest.fixture
def service(
    cache: ParquetSentimentCache,
    meta_repo: _FakeMetaRepo,
) -> NewsSentimentService:
    search = _ScriptedSearchLLM([_RESEARCH_TEXT_MAOTAI])
    # Aggregator script ordering for a single analyze_one call: 1× summarise.
    # analyze_many would consume more (per-stock summarise + cluster + synth).
    agg = _ScriptedAggregatorLLM([
        json.dumps(_maotai_payload()),
        json.dumps(_cluster_payload()),
        json.dumps(_market_payload()),
    ])
    return NewsSentimentService(
        search_llm=search,
        aggregator_llm=agg,
        cache=cache,
        meta_repo=meta_repo,
        clock=FrozenClock(_NOW),
        config=NewsSentimentConfig(
            max_searches_per_stock=4,
            multi_stock_concurrency=2,
        ),
    )


@pytest.mark.unit
class TestAnalyzeOne:
    def test_golden_path_populates_structured_fields_and_result(
        self, service: NewsSentimentService
    ) -> None:
        result = service.analyze_one("600519", days=30, asof=_TODAY)
        assert isinstance(result, StockSentiment)
        assert result.code == "600519"
        assert result.window_days == 30
        assert result.sentiment_score == pytest.approx(0.6)
        # Step-1 plain-text reply preserved verbatim.
        assert result.result == _RESEARCH_TEXT_MAOTAI
        # Step-2 flash summariser populated structured fields directly
        # from the analyst write-up — no per-claim evidence carried.
        assert len(result.core_drivers) == 1
        assert result.core_drivers[0].summary == "高端白酒动销改善"
        assert result.hot_themes[0].label == "高端白酒"
        assert result.research_targets[0].broker == "中金"
        assert str(result.research_targets[0].target_upside_pct) == "25.0"

    def test_unknown_code_raises_stock_not_found(
        self, service: NewsSentimentService
    ) -> None:
        with pytest.raises(QuantError) as exc:
            service.analyze_one("999999", days=30, asof=_TODAY)
        assert exc.value.code == "STOCK_NOT_FOUND"

    def test_zero_days_rejected(self, service: NewsSentimentService) -> None:
        with pytest.raises(QuantError) as exc:
            service.analyze_one("600519", days=0, asof=_TODAY)
        assert exc.value.code == "INVALID_ARGUMENT"

    def test_cache_hit_skips_llm_within_seven_days(
        self,
        tmp_path: Path,
        meta_repo: _FakeMetaRepo,
    ) -> None:
        clock = FrozenClock(_NOW)
        cache = _build_cache(tmp_path, clock)
        search1 = _ScriptedSearchLLM([_RESEARCH_TEXT_MAOTAI])
        agg1 = _ScriptedAggregatorLLM([json.dumps(_maotai_payload())])
        svc1 = NewsSentimentService(
            search_llm=search1,
            aggregator_llm=agg1,
            cache=cache,
            meta_repo=meta_repo,
            clock=clock,
        )
        first = svc1.analyze_one("600519", days=30, asof=_TODAY)
        assert len(search1.calls) == 1
        assert len(agg1.calls) == 1

        clock.advance(seconds=24 * 3600)
        search2 = _ScriptedSearchLLM(["unrelated"])
        agg2 = _ScriptedAggregatorLLM([json.dumps(_maotai_payload(score=-0.99))])
        svc2 = NewsSentimentService(
            search_llm=search2,
            aggregator_llm=agg2,
            cache=cache,
            meta_repo=meta_repo,
            clock=clock,
        )
        second = svc2.analyze_one("600519", days=30, asof=_TODAY)
        assert search2.calls == []
        assert agg2.calls == []
        assert second.sentiment_score == first.sentiment_score
        assert second.result == first.result

    def test_cache_expires_after_seven_days(
        self,
        tmp_path: Path,
        meta_repo: _FakeMetaRepo,
    ) -> None:
        clock = FrozenClock(_NOW)
        cache = _build_cache(tmp_path, clock)
        search = _ScriptedSearchLLM([_RESEARCH_TEXT_MAOTAI])
        agg = _ScriptedAggregatorLLM([
            json.dumps(_maotai_payload(score=0.6)),
            json.dumps(_maotai_payload(score=-0.2)),
        ])
        svc = NewsSentimentService(
            search_llm=search,
            aggregator_llm=agg,
            cache=cache,
            meta_repo=meta_repo,
            clock=clock,
        )
        first = svc.analyze_one("600519", days=30, asof=_TODAY)
        assert first.sentiment_score == pytest.approx(0.6)

        clock.advance(seconds=7 * 24 * 3600)
        refreshed = svc.analyze_one("600519", days=30, asof=_TODAY)
        assert refreshed.sentiment_score == pytest.approx(-0.2)
        assert len(search.calls) == 2
        assert len(agg.calls) == 2

    def test_bypass_cache_forces_re_query(
        self,
        tmp_path: Path,
        meta_repo: _FakeMetaRepo,
    ) -> None:
        clock = FrozenClock(_NOW)
        cache = _build_cache(tmp_path, clock)
        search = _ScriptedSearchLLM([_RESEARCH_TEXT_MAOTAI])
        agg = _ScriptedAggregatorLLM([
            json.dumps(_maotai_payload(score=0.6)),
            json.dumps(_maotai_payload(score=0.1)),
        ])
        svc = NewsSentimentService(
            search_llm=search,
            aggregator_llm=agg,
            cache=cache,
            meta_repo=meta_repo,
            clock=clock,
        )
        svc.analyze_one("600519", days=30, asof=_TODAY)
        refreshed = svc.analyze_one(
            "600519", days=30, asof=_TODAY, bypass_cache=True
        )
        assert refreshed.sentiment_score == pytest.approx(0.1)
        assert len(search.calls) == 2
        assert len(agg.calls) == 2

    def test_invalid_summariser_json_then_valid_passes_after_retry(
        self,
        cache: ParquetSentimentCache,
        meta_repo: _FakeMetaRepo,
    ) -> None:
        # Search returns valid analyst text once; aggregator emits garbage
        # then valid JSON — the service must retry the summarise step
        # without re-running the (expensive) web-search.
        search = _ScriptedSearchLLM([_RESEARCH_TEXT_MAOTAI])
        agg = _ScriptedAggregatorLLM([
            "not json at all",
            json.dumps(_maotai_payload()),
        ])
        svc = NewsSentimentService(
            search_llm=search,
            aggregator_llm=agg,
            cache=cache,
            meta_repo=meta_repo,
            clock=FrozenClock(_NOW),
        )
        result = svc.analyze_one("600519", days=30, asof=_TODAY)
        assert result.code == "600519"
        assert result.result == _RESEARCH_TEXT_MAOTAI
        assert len(search.calls) == 1
        assert len(agg.calls) == 2

    def test_two_consecutive_summariser_failures_raise_llm_failed(
        self,
        cache: ParquetSentimentCache,
        meta_repo: _FakeMetaRepo,
    ) -> None:
        search = _ScriptedSearchLLM([_RESEARCH_TEXT_MAOTAI])
        agg = _ScriptedAggregatorLLM(["garbage", "still garbage"])
        svc = NewsSentimentService(
            search_llm=search,
            aggregator_llm=agg,
            cache=cache,
            meta_repo=meta_repo,
            clock=FrozenClock(_NOW),
        )
        with pytest.raises(QuantError) as exc:
            svc.analyze_one("600519", days=30, asof=_TODAY)
        assert exc.value.code == "LLM_FAILED"


@pytest.mark.unit
class TestAnalyzeMany:
    def test_clusters_and_market_trend(
        self,
        cache: ParquetSentimentCache,
        meta_repo: _FakeMetaRepo,
    ) -> None:
        # Each stock consumes 1 search + 1 aggregator (summarise);
        # afterwards aggregator handles cluster + market_synth.
        search = _ScriptedSearchLLM([_RESEARCH_TEXT_MAOTAI, _RESEARCH_TEXT_WULIANGYE])
        agg = _ScriptedAggregatorLLM([
            json.dumps(_maotai_payload()),
            json.dumps(_wuliangye_payload()),
            json.dumps(_cluster_payload()),
            json.dumps(_market_payload()),
        ])
        svc = NewsSentimentService(
            search_llm=search,
            aggregator_llm=agg,
            cache=cache,
            meta_repo=meta_repo,
            clock=FrozenClock(_NOW),
            config=NewsSentimentConfig(
                max_searches_per_stock=4, multi_stock_concurrency=1
            ),
        )

        result = svc.analyze_many(["600519", "000858"], days=30, asof=_TODAY)
        assert isinstance(result, MarketSentiment)
        assert sorted(result.per_stock.keys()) == ["000858", "600519"]
        assert len(result.theme_clusters) == 1
        assert set(result.theme_clusters[0].member_codes) == {"600519", "000858"}
        assert result.theme_clusters[0].trend == "rising"
        assert result.market_trend.summary == "消费板块阶段性占优"
        assert result.industry_trends[0].direction == "improving"

    def test_empty_codes_rejected(self, service: NewsSentimentService) -> None:
        with pytest.raises(QuantError) as exc:
            service.analyze_many([], days=30, asof=_TODAY)
        assert exc.value.code == "INVALID_ARGUMENT"

    def test_unknown_code_recorded_as_caveat_not_fatal(
        self,
        cache: ParquetSentimentCache,
        meta_repo: _FakeMetaRepo,
    ) -> None:
        search = _ScriptedSearchLLM([_RESEARCH_TEXT_MAOTAI])
        agg = _ScriptedAggregatorLLM([
            json.dumps(_maotai_payload()),
            json.dumps(_cluster_payload()),
            json.dumps(_market_payload()),
        ])
        svc = NewsSentimentService(
            search_llm=search,
            aggregator_llm=agg,
            cache=cache,
            meta_repo=meta_repo,
            clock=FrozenClock(_NOW),
            config=NewsSentimentConfig(
                max_searches_per_stock=4, multi_stock_concurrency=1
            ),
        )
        result = svc.analyze_many(["600519", "999999"], days=30, asof=_TODAY)
        assert "600519" in result.per_stock
        assert "999999" not in result.per_stock
        assert any("999999" in c for c in result.caveats)

    def test_all_failures_raise_llm_failed(
        self,
        cache: ParquetSentimentCache,
        meta_repo: _FakeMetaRepo,
    ) -> None:
        # Repo lacks every requested code; every analyze_one raises
        # STOCK_NOT_FOUND, no per-stock payloads survive.
        empty_repo = _FakeMetaRepo([make_meta("999998")])
        svc = NewsSentimentService(
            search_llm=_ScriptedSearchLLM(["never read"]),
            aggregator_llm=_ScriptedAggregatorLLM(["{}"]),
            cache=cache,
            meta_repo=empty_repo,
            clock=FrozenClock(_NOW),
            config=NewsSentimentConfig(multi_stock_concurrency=1),
        )
        with pytest.raises(QuantError) as exc:
            svc.analyze_many(["aaa", "bbb"], days=30, asof=date(2026, 5, 1))
        assert exc.value.code == "LLM_FAILED"

    def test_multi_stock_cache_reuse(
        self,
        cache: ParquetSentimentCache,
        meta_repo: _FakeMetaRepo,
    ) -> None:
        search = _ScriptedSearchLLM([_RESEARCH_TEXT_MAOTAI, _RESEARCH_TEXT_WULIANGYE])
        agg = _ScriptedAggregatorLLM([
            json.dumps(_maotai_payload()),
            json.dumps(_wuliangye_payload()),
            json.dumps(_cluster_payload()),
            json.dumps(_market_payload()),
        ])
        svc = NewsSentimentService(
            search_llm=search,
            aggregator_llm=agg,
            cache=cache,
            meta_repo=meta_repo,
            clock=FrozenClock(_NOW),
            config=NewsSentimentConfig(multi_stock_concurrency=1),
        )

        first = svc.analyze_many(["600519", "000858"], days=30, asof=_TODAY)

        # Reordered codes — same canonical key, must hit market cache and
        # not call any LLM.
        search2 = _ScriptedSearchLLM(["unused"])
        agg2 = _ScriptedAggregatorLLM(["{}"])
        svc2 = NewsSentimentService(
            search_llm=search2,
            aggregator_llm=agg2,
            cache=cache,
            meta_repo=meta_repo,
            clock=FrozenClock(_NOW),
        )
        second = svc2.analyze_many(["000858", "600519"], days=30, asof=_TODAY)
        assert search2.calls == []
        assert agg2.calls == []
        assert (
            second.theme_clusters[0].theme_label
            == first.theme_clusters[0].theme_label
        )
