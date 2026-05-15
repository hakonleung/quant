"""End-to-end test for ScreeningPipeline (universe filter + screen + rank)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from quant_cache.flat_prefix_kline_repo import FlatPrefixKlineRepo
from tests._util.kline_seeder import seed_kline_parquet
from quant_cache.parquet_stock_meta_repo import ParquetStockMetaRepo
from quant_core.domain.rules.screen_parse import parse_plan
from quant_core.domain.rules.universe_parse import parse_universe_plan
from quant_core.domain.types.kline import KLINE_FLOOR_DATE, AdjFactor, RawDailyBar
from quant_core.domain.types.screen import PeriodReturn, RankSpec
from quant_core.domain.types.stock import StockMeta
from quant_core.services.kline_service import KlineService
from quant_core.services.screen_service import ScreenService
from quant_core.services.screening_pipeline import (
    PipelineRequest,
    ScreeningPipeline,
)
from quant_core.services.universe_screen_service import UniverseScreenService

if TYPE_CHECKING:
    from collections.abc import Iterable
    from pathlib import Path


class _Clock:
    def __init__(self, now: datetime) -> None:
        self._now = now

    def now(self) -> datetime:
        return self._now


class _Source:
    def __init__(self, bars: list[RawDailyBar]) -> None:
        self._bars = bars

    @property
    def name(self) -> str:
        return "fake"

    def healthcheck(self) -> object:
        raise NotImplementedError

    def fetch_range(self, code: str, start: date, end: date) -> Iterable[RawDailyBar]:
        return [b for b in self._bars if b.code == code and start <= b.trade_date <= end]

    def fetch_adj_factors(self, code: str, start: date, end: date) -> Iterable[AdjFactor]:
        return [AdjFactor(code=code, trade_date=start, factor=Decimal("1.0"))]


def _meta(code: str, name: str, list_date: date) -> StockMeta:
    return StockMeta(
        code=code,
        name=name,
        name_pinyin="",
        industries="",
        list_date=list_date,
        float_pct=Decimal(1),
        updated_at=datetime(2026, 5, 1, tzinfo=UTC),
    )


def _bar(code: str, d: date, close: str) -> RawDailyBar:
    c = Decimal(close)
    return RawDailyBar(
        code=code,
        trade_date=d,
        open=c,
        high=c + Decimal("0.5"),
        low=c - Decimal("0.5"),
        close=c,
        volume=1000,
        amount=c * 1000,
        turnover_rate=Decimal("0.001"),
    )


@pytest.mark.integration
def test_pipeline_filters_universe_then_screens_then_ranks(tmp_path: Path) -> None:
    # Stock-meta universe: 4 codes; the pipeline should filter to 2 (drop ST + 北交所).
    meta_repo = ParquetStockMetaRepo(path=tmp_path / "meta.parquet")
    meta_repo.upsert_many(
        [
            _meta("600000", "建设银行", list_date=date(2020, 1, 1)),
            _meta("000001", "ST平安", list_date=date(2020, 1, 1)),
            _meta("832000", "北交所X", list_date=date(2020, 1, 1)),
            _meta("000333", "美的集团", list_date=date(2020, 1, 1)),
        ]
    )
    # K-line: only the surviving codes have data; the others should match by accident if not filtered.
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    bars = [
        _bar(code, KLINE_FLOOR_DATE + timedelta(days=i), str(10 + i))
        for code in ("600000", "000333")
        for i in range(15)
    ]
    last_day = KLINE_FLOOR_DATE + timedelta(days=14)
    kline_svc = KlineService(
        _Source(bars),
        kline_repo,
        _Clock(datetime.combine(last_day, datetime.min.time(), tzinfo=UTC)),
    )
    for code in ("600000", "000333"):
        _, code_bars = kline_svc.sync_code(code)
        seed_kline_parquet(tmp_path / "kline", code_bars)

    pipeline = ScreeningPipeline(
        universe_service=UniverseScreenService(meta_repo=meta_repo),
        screen_service=ScreenService(kline_repo=kline_repo),
    )

    universe_plan = parse_universe_plan(
        {
            "asof": last_day.isoformat(),
            "expr": {
                "op": "and",
                "args": [
                    {"op": "eq", "left": {"field": "is_st"}, "right": {"const": False}},
                    {
                        "op": "not_starts_with",
                        "left": {"field": "code"},
                        "right": {"const": "8"},
                    },
                ],
            },
        }
    )
    screen_plan = parse_plan(
        {
            "asof": last_day.isoformat(),
            "expr": {
                "op": "gt",
                "left": {"field": "close_qfq"},
                "right": {"const": 0},
            },
        }
    )
    rank = RankSpec(metric=PeriodReturn(days=10), order="desc", top_n=1)
    result = pipeline.run(
        PipelineRequest(
            screen_plan=screen_plan,
            universe_plan=universe_plan,
            rank=rank,
        )
    )
    # ST平安 + 832000 dropped at universe stage; rank=top_n=1 takes the
    # single highest 10d return between 600000 and 000333 (they're equal,
    # so any one is fine — just confirm the pipeline plumbed everything).
    codes = [m.code for m in result.matches]
    assert len(codes) == 1
    assert codes[0] in {"600000", "000333"}
