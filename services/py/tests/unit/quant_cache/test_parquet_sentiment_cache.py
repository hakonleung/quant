"""Unit tests for :class:`ParquetSentimentCache`.

Mirrors the kline-cache test pattern: real parquet files on disk under
``tmp_path``, no mocks — the per-file lock + atomic-write contract is
end-to-end-tested by writing and reading actual ``.parquet`` files.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pyarrow.parquet as pq
import pytest
from quant_cache.parquet_sentiment_cache import ParquetSentimentCache
from quant_core.domain.types.sentiment import (
    Evidence,
    Insight,
    MarketSentiment,
    MarketTrend,
    ResearchTarget,
    StockSentiment,
    ThemeCluster,
    ThemeTag,
)

from tests._util.clock import FrozenClock

if TYPE_CHECKING:
    from pathlib import Path


_ASOF = date(2026, 5, 1)
_FETCHED_AT = datetime(2026, 5, 1, 9, 30, tzinfo=UTC)


def _stock(
    code: str = "600519",
    *,
    score: float = 0.6,
    asof: date = _ASOF,
    window_days: int = 30,
) -> StockSentiment:
    evidence = (
        Evidence(
            source_type="research",
            quoted_text="批价企稳",
            url="https://example.com/r/1",
            published_at=date(2026, 4, 30),
        ),
    )
    return StockSentiment(
        code=code,
        asof=asof,
        window_days=window_days,
        sentiment_score=score,
        fetched_at=_FETCHED_AT,
        core_drivers=(
            Insight(
                summary="动销改善",
                direction="positive",
                confidence=0.8,
                is_rumor=False,
                evidence=evidence,
            ),
        ),
        hot_themes=(
            ThemeTag(
                label="高端白酒",
                relevance=0.9,
                rationale="行业龙头",
                evidence=evidence,
            ),
        ),
        research_targets=(
            ResearchTarget(
                broker="中金",
                url="https://example.com/r/2",
                rating="买入",
                target_price=Decimal("2000.0"),
                target_upside_pct=Decimal("25.5"),
                horizon_months=12,
                report_date=date(2026, 4, 15),
            ),
        ),
        coverage_gaps=("xueqiu",),
    )


@pytest.mark.unit
class TestStockRoundTrip:
    def test_put_then_get(self, tmp_path: Path) -> None:
        cache = ParquetSentimentCache(tmp_path, FrozenClock(_FETCHED_AT))
        stock = _stock()
        cache.put_stock(stock)
        loaded = cache.get_stock("600519", _ASOF, 30)
        assert loaded == stock

    def test_get_missing_returns_none(self, tmp_path: Path) -> None:
        cache = ParquetSentimentCache(tmp_path, FrozenClock(_FETCHED_AT))
        assert cache.get_stock("000001", _ASOF, 30) is None

    def test_window_days_mismatch_treated_as_miss(self, tmp_path: Path) -> None:
        cache = ParquetSentimentCache(tmp_path, FrozenClock(_FETCHED_AT))
        cache.put_stock(_stock())
        assert cache.get_stock("600519", _ASOF, 60) is None

    def test_two_windows_share_one_file(self, tmp_path: Path) -> None:
        """One per-code file holds multiple (asof, window_days) rows."""
        cache = ParquetSentimentCache(tmp_path, FrozenClock(_FETCHED_AT))
        cache.put_stock(_stock(window_days=30, score=0.6))
        cache.put_stock(_stock(window_days=60, score=-0.2))
        loaded_30 = cache.get_stock("600519", _ASOF, 30)
        loaded_60 = cache.get_stock("600519", _ASOF, 60)
        assert loaded_30 is not None
        assert loaded_30.sentiment_score == pytest.approx(0.6)
        assert loaded_60 is not None
        assert loaded_60.sentiment_score == pytest.approx(-0.2)
        path = tmp_path / "stock" / "600519.parquet"
        assert pq.read_table(path).num_rows == 2

    def test_upsert_replaces_same_key(self, tmp_path: Path) -> None:
        cache = ParquetSentimentCache(tmp_path, FrozenClock(_FETCHED_AT))
        cache.put_stock(_stock(score=0.6))
        cache.put_stock(_stock(score=-0.9))  # same (code, asof, window_days)
        loaded = cache.get_stock("600519", _ASOF, 30)
        assert loaded is not None
        assert loaded.sentiment_score == pytest.approx(-0.9)
        path = tmp_path / "stock" / "600519.parquet"
        assert pq.read_table(path).num_rows == 1

    def test_corrupted_parquet_treated_as_miss_and_removed(
        self, tmp_path: Path
    ) -> None:
        cache = ParquetSentimentCache(tmp_path, FrozenClock(_FETCHED_AT))
        cache.put_stock(_stock())
        path = tmp_path / "stock" / "600519.parquet"
        path.write_bytes(b"not a parquet file at all")
        assert cache.get_stock("600519", _ASOF, 30) is None
        assert not path.exists()


@pytest.mark.unit
class TestExpiry:
    def test_hit_one_day_after_asof(self, tmp_path: Path) -> None:
        clock = FrozenClock(_FETCHED_AT)
        cache = ParquetSentimentCache(tmp_path, clock)
        cache.put_stock(_stock())
        clock.advance(seconds=24 * 3600)
        assert cache.get_stock("600519", _ASOF, 30) is not None

    def test_miss_at_exactly_two_days(self, tmp_path: Path) -> None:
        clock = FrozenClock(_FETCHED_AT)
        cache = ParquetSentimentCache(tmp_path, clock)
        cache.put_stock(_stock())
        target = datetime.combine(_ASOF + timedelta(days=2), datetime.min.time(), tzinfo=UTC)
        clock.advance(seconds=(target - _FETCHED_AT).total_seconds())
        assert cache.get_stock("600519", _ASOF, 30) is None

    def test_expired_row_filtered_at_read_time(self, tmp_path: Path) -> None:
        """The expiry filter on read keeps stale rows from leaking through."""
        clock = FrozenClock(_FETCHED_AT)
        cache = ParquetSentimentCache(tmp_path, clock)
        # Two rows in the same per-code file: one fresh, one already stale.
        cache.put_stock(_stock(asof=date(2026, 4, 1), score=0.1))  # expires 2026-04-03
        cache.put_stock(_stock(asof=_ASOF, score=0.7))             # expires 2026-05-03
        # Sit on 2026-05-02 — only the second row is still valid.
        clock.advance(seconds=24 * 3600)  # _FETCHED_AT + 1d → 2026-05-02 09:30Z
        assert cache.get_stock("600519", date(2026, 4, 1), 30) is None
        loaded = cache.get_stock("600519", _ASOF, 30)
        assert loaded is not None
        assert loaded.sentiment_score == pytest.approx(0.7)


@pytest.mark.unit
class TestInvalidate:
    def test_invalidate_deletes_per_code_file(self, tmp_path: Path) -> None:
        cache = ParquetSentimentCache(tmp_path, FrozenClock(_FETCHED_AT))
        cache.put_stock(_stock(asof=date(2026, 5, 1)))
        cache.put_stock(_stock(asof=date(2026, 5, 2)))
        cache.invalidate_stock("600519")
        assert cache.get_stock("600519", date(2026, 5, 1), 30) is None
        assert cache.get_stock("600519", date(2026, 5, 2), 30) is None
        assert not (tmp_path / "stock" / "600519.parquet").exists()


@pytest.mark.unit
class TestMarketKey:
    def test_codes_order_does_not_change_key(self, tmp_path: Path) -> None:
        cache = ParquetSentimentCache(tmp_path, FrozenClock(_FETCHED_AT))
        market = MarketSentiment(
            asof=_ASOF,
            window_days=30,
            fetched_at=_FETCHED_AT,
            per_stock={"600519": _stock("600519"), "000858": _stock("000858")},
            theme_clusters=(
                ThemeCluster(
                    theme_label="高端白酒",
                    member_codes=("600519", "000858"),
                    related_industries=("食品饮料",),
                    heat_score=0.9,
                    trend="rising",
                    summary="",
                ),
            ),
            market_trend=MarketTrend(summary="", style_signals=(), caveats=()),
        )
        cache.put_market(market)
        loaded = cache.get_market(["000858", "600519"], _ASOF, 30)
        assert loaded is not None
        assert loaded.theme_clusters[0].theme_label == "高端白酒"

    def test_window_in_key(self, tmp_path: Path) -> None:
        cache = ParquetSentimentCache(tmp_path, FrozenClock(_FETCHED_AT))
        market = MarketSentiment(
            asof=_ASOF,
            window_days=30,
            fetched_at=_FETCHED_AT,
            per_stock={"600519": _stock("600519")},
        )
        cache.put_market(market)
        assert cache.get_market(["600519"], _ASOF, 60) is None
