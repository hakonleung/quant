"""Integration tests for ScreenService — pulls data through the real
:class:`ParquetKlineRepo`."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from quant_cache.parquet_kline_repo import ParquetKlineRepo
from quant_core.domain.rules.screen_parse import parse_plan
from quant_core.domain.types.kline import KLINE_FLOOR_DATE, AdjFactor, RawDailyBar
from quant_core.services.kline_service import KlineService
from quant_core.services.screen_service import (
    ScreenService,
    except_,
    intersect,
    plan_signature,
    union,
)

if TYPE_CHECKING:
    from collections.abc import Iterable
    from pathlib import Path


class _FakeClock:
    def __init__(self, now: datetime) -> None:
        self._now = now

    def now(self) -> datetime:
        return self._now


class _FakeSource:
    def __init__(self, bars: list[RawDailyBar], factors: list[AdjFactor]) -> None:
        self._bars = bars
        self._factors = factors

    @property
    def name(self) -> str:
        return "fake"

    def healthcheck(self) -> object:
        raise NotImplementedError

    def fetch_range(self, code: str, start: date, end: date) -> Iterable[RawDailyBar]:
        return [b for b in self._bars if b.code == code and start <= b.trade_date <= end]

    def fetch_adj_factors(self, code: str, start: date, end: date) -> Iterable[AdjFactor]:
        same = [f for f in self._factors if f.code == code]
        if not same:
            return []
        first = min(same, key=lambda f: f.trade_date)
        return [AdjFactor(code=code, trade_date=start, factor=first.factor)]


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


def _seed_repo_and_service(tmp_path: Path, codes_closes: dict[str, list[str]]) -> ScreenService:
    """Backfill the kline repo for several codes with monotonic close prices."""
    base = KLINE_FLOOR_DATE
    bars: list[RawDailyBar] = []
    factors: list[AdjFactor] = []
    for code, closes in codes_closes.items():
        for i, c in enumerate(closes):
            bars.append(_bar(code, base + timedelta(days=i), c))
        factors.append(AdjFactor(code=code, trade_date=base, factor=Decimal("1.0")))
    src = _FakeSource(bars, factors)
    repo = ParquetKlineRepo(root=tmp_path)
    last_day = base + timedelta(days=max(len(v) for v in codes_closes.values()))
    clock = _FakeClock(datetime.combine(last_day, datetime.min.time(), tzinfo=UTC))
    svc = KlineService(src, repo, clock)
    for code in codes_closes:
        svc.sync_code(code)
    return ScreenService(kline_repo=repo)


@pytest.mark.integration
def test_close_above_ma5_for_5d_picks_uptrend(tmp_path: Path) -> None:
    # 600000 is a strict uptrend (close > ma5 for ≥5 trailing days);
    # 000001 is flat → ma5 == close, fails strict gt.
    svc = _seed_repo_and_service(
        tmp_path,
        {
            "600000": [str(10 + i) for i in range(15)],  # 10..24
            "000001": ["10"] * 15,
        },
    )
    asof = KLINE_FLOOR_DATE + timedelta(days=14)
    plan = parse_plan(
        {
            "asof": asof.isoformat(),
            "expr": {
                "op": "for_all",
                "window": {"days": 5},
                "predicate": {
                    "op": "gt",
                    "left": {"field": "close_qfq"},
                    "right": {"field": "ma5"},
                },
            },
        }
    )
    result = svc.execute(plan, ["600000", "000001"])
    codes = [m.code for m in result.matches]
    assert "600000" in codes
    assert "000001" not in codes


@pytest.mark.integration
def test_period_return_threshold(tmp_path: Path) -> None:
    svc = _seed_repo_and_service(
        tmp_path,
        {
            "600000": [str(10 + i * 2) for i in range(25)],  # +200% over 25
            "000001": [str(10 + i * 0.05) for i in range(25)],  # tiny growth
        },
    )
    asof = KLINE_FLOOR_DATE + timedelta(days=24)
    plan = parse_plan(
        {
            "asof": asof.isoformat(),
            "expr": {
                "op": "gt",
                "left": {"period_return": {"days": 20}},
                "right": {"const": 0.30},
            },
        }
    )
    result = svc.execute(plan, ["600000", "000001"])
    codes = [m.code for m in result.matches]
    assert "600000" in codes
    assert "000001" not in codes


@pytest.mark.integration
def test_set_intersect_union_except(tmp_path: Path) -> None:
    svc = _seed_repo_and_service(
        tmp_path, {"A": ["10", "11", "12"], "B": ["10", "11", "12"], "C": ["10", "11", "12"]}
    )
    asof = KLINE_FLOOR_DATE + timedelta(days=2)
    plan_a = parse_plan(
        {
            "asof": asof.isoformat(),
            "expr": {"op": "gt", "left": {"field": "close_qfq"}, "right": {"const": 0}},
        }
    )
    full = svc.execute(plan_a, ["A", "B", "C"])
    subset = svc.execute(plan_a, ["A", "B"])
    inter = intersect(full, subset)
    uni = union(full, subset)
    diff = except_(full, subset)
    assert {m.code for m in inter.matches} == {"A", "B"}
    assert {m.code for m in uni.matches} == {"A", "B", "C"}
    assert {m.code for m in diff.matches} == {"C"}


@pytest.mark.integration
def test_plan_signature_is_deterministic(tmp_path: Path) -> None:
    plan = parse_plan(
        {
            "asof": "2026-04-30",
            "expr": {"op": "gt", "left": {"field": "close_qfq"}, "right": {"const": 1}},
        }
    )
    sig1 = plan_signature(plan)
    sig2 = plan_signature(plan)
    assert sig1 == sig2
    assert len(sig1) == 64


@pytest.mark.integration
def test_empty_universe_returns_empty(tmp_path: Path) -> None:
    svc = _seed_repo_and_service(tmp_path, {"A": ["10", "11"]})
    plan = parse_plan(
        {
            "asof": (KLINE_FLOOR_DATE + timedelta(days=1)).isoformat(),
            "expr": {"op": "gt", "left": {"field": "close_qfq"}, "right": {"const": 0}},
        }
    )
    result = svc.execute(plan, [])
    assert result.matches == ()
