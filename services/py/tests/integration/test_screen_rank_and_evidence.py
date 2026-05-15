"""Integration tests for the new RankSpec + per-condition evidence."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from quant_cache.flat_prefix_kline_repo import FlatPrefixKlineRepo
from tests._util.kline_seeder import seed_kline_parquet
from quant_core.domain.rules.screen_parse import parse_plan
from quant_core.domain.types.kline import KLINE_FLOOR_DATE, AdjFactor, RawDailyBar
from quant_core.domain.types.screen import PeriodReturn, RankSpec
from quant_core.services.kline_service import KlineService
from quant_core.services.screen_service import ScreenService

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


def _seed(tmp_path: Path, codes_closes: dict[str, list[str]]) -> ScreenService:
    base = KLINE_FLOOR_DATE
    bars = [
        _bar(code, base + timedelta(days=i), c)
        for code, closes in codes_closes.items()
        for i, c in enumerate(closes)
    ]
    repo = FlatPrefixKlineRepo(root=tmp_path)
    last_day = base + timedelta(days=max(len(v) for v in codes_closes.values()))
    clock = _Clock(datetime.combine(last_day, datetime.min.time(), tzinfo=UTC))
    svc = KlineService(_Source(bars), repo, clock)
    for code in codes_closes:
        _, bars = svc.sync_code(code)
        seed_kline_parquet(tmp_path, bars)
    return ScreenService(kline_repo=repo)


@pytest.mark.integration
def test_rank_top_n_by_period_return(tmp_path: Path) -> None:
    svc = _seed(
        tmp_path,
        {
            "A": [str(10 + i) for i in range(15)],  # +40% over 14 days, ret_10d ≈ +71%
            "B": [str(10 + i * 0.5) for i in range(15)],  # +20% over 14 days, ret_10d ≈ +29%
            "C": [str(10 + i * 0.1) for i in range(15)],  # +1.4% over 14 days
        },
    )
    asof = KLINE_FLOOR_DATE + timedelta(days=14)
    plan = parse_plan(
        {
            "asof": asof.isoformat(),
            "expr": {
                "op": "gt",
                "left": {"field": "close_qfq"},
                "right": {"const": 0},
            },
        }
    )
    rank = RankSpec(metric=PeriodReturn(days=10), order="desc", top_n=2)
    result = svc.execute(plan, ["A", "B", "C"], rank=rank)
    codes = [m.code for m in result.matches]
    assert codes == ["A", "B"]  # top-2 by 10d return
    # rank metric attached to each match
    for m in result.matches:
        assert "rank_metric" in m.evidence


@pytest.mark.integration
def test_evidence_carries_per_condition_metrics(tmp_path: Path) -> None:
    svc = _seed(tmp_path, {"A": [str(10 + i) for i in range(20)]})
    asof = KLINE_FLOOR_DATE + timedelta(days=19)
    plan = parse_plan(
        {
            "asof": asof.isoformat(),
            "expr": {
                "op": "and",
                "args": [
                    {
                        "op": "gt",
                        "left": {"period_return": {"days": 10}},
                        "right": {"const": 0.1},
                    },
                    {
                        "op": "lt",
                        "left": {
                            "agg": "mean",
                            "field": "turnover_rate",
                            "window": {"days": 5},
                        },
                        "right": {"const": 0.27},
                    },
                ],
            },
        }
    )
    result = svc.execute(plan, ["A"])
    assert len(result.matches) == 1
    metrics = result.matches[0].evidence["metrics"]
    assert isinstance(metrics, dict)
    # Each Compare's left scalar produced a labelled metric:
    assert "period_return_10d" in metrics
    assert "mean_turnover_rate_5d" in metrics


@pytest.mark.integration
def test_evidence_metrics_for_field_compare(tmp_path: Path) -> None:
    svc = _seed(tmp_path, {"A": [str(10 + i) for i in range(8)]})
    asof = KLINE_FLOOR_DATE + timedelta(days=7)
    plan = parse_plan(
        {
            "asof": asof.isoformat(),
            "expr": {
                "op": "gt",
                "left": {"field": "close_qfq"},
                "right": {"field": "ma5"},
            },
        }
    )
    result = svc.execute(plan, ["A"])
    assert len(result.matches) == 1
    metrics = result.matches[0].evidence["metrics"]
    assert isinstance(metrics, dict)
    assert "close_qfq" in metrics
    assert "ma5" in metrics
