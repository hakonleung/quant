"""Integration tests for ParquetKlineRepo + KlineService.

Uses a fake :class:`KlineSource` so we never hit the network. Real
parquet IO + DuckDB go through the actual disk.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from quant_cache.parquet_kline_repo import ParquetKlineRepo
from quant_core.domain.types.kline import KLINE_FLOOR_DATE, AdjFactor, RawDailyBar
from quant_core.errors import QuantError
from quant_core.services.kline_service import KlineService

if TYPE_CHECKING:
    from collections.abc import Iterable
    from pathlib import Path


class _FakeClock:
    def __init__(self, now: datetime) -> None:
        self._now = now

    def now(self) -> datetime:
        return self._now


class _FakeSource:
    def __init__(
        self,
        bars: list[RawDailyBar],
        factors: list[AdjFactor],
    ) -> None:
        self._bars = bars
        self._factors = factors
        self.fetch_calls = 0

    @property
    def name(self) -> str:
        return "fake"

    def healthcheck(self) -> object:  # pragma: no cover - unused in these tests
        raise NotImplementedError

    def fetch_range(self, code: str, start: date, end: date) -> Iterable[RawDailyBar]:
        self.fetch_calls += 1
        return [b for b in self._bars if b.code == code and start <= b.trade_date <= end]

    def fetch_adj_factors(self, code: str, start: date, end: date) -> Iterable[AdjFactor]:
        relevant = [f for f in self._factors if f.code == code and start <= f.trade_date <= end]
        if not relevant:
            # Anchor the earliest factor at start so qfq has a baseline.
            same_code = [f for f in self._factors if f.code == code]
            if same_code:
                first = min(same_code, key=lambda f: f.trade_date)
                return [AdjFactor(code=code, trade_date=start, factor=first.factor)]
            return []
        return relevant


def _bar(code: str, d: date, close: str = "10") -> RawDailyBar:
    return RawDailyBar(
        code=code,
        trade_date=d,
        open=Decimal(close),
        high=Decimal(close) + Decimal("0.5"),
        low=Decimal(close) - Decimal("0.5"),
        close=Decimal(close),
        volume=1000,
        amount=Decimal(close) * 1000,
        turnover_rate=Decimal("0.001"),
    )


def _factor(code: str, d: date, factor: str = "1.0") -> AdjFactor:
    return AdjFactor(code=code, trade_date=d, factor=Decimal(factor))


def _make_bars(code: str, days: int) -> list[RawDailyBar]:
    return [_bar(code, KLINE_FLOOR_DATE + timedelta(days=i)) for i in range(days)]


@pytest.mark.integration
def test_backfill_then_query_round_trip(tmp_path: Path) -> None:
    bars = _make_bars("600000", 65)
    factors = [_factor("600000", KLINE_FLOOR_DATE)]
    src = _FakeSource(bars, factors)
    repo = ParquetKlineRepo(root=tmp_path)
    clock = _FakeClock(datetime(2026, 5, 1, tzinfo=UTC))
    svc = KlineService(src, repo, clock)

    rep = svc.sync_code("600000")
    assert rep.mode == "backfill"
    assert rep.written_bars == 65

    last = repo.get_last_bar("600000")
    assert last is not None
    assert last.ma60 is not None  # 60-day MA fully populated by row 60+
    assert last.adj_factor == Decimal("1.0000")


@pytest.mark.integration
def test_get_range_drops_trade_date_when_not_requested(tmp_path: Path) -> None:
    src = _FakeSource(_make_bars("600000", 5), [_factor("600000", KLINE_FLOOR_DATE)])
    repo = ParquetKlineRepo(root=tmp_path)
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    svc.sync_code("600000")

    table = repo.get_range(
        "600000", KLINE_FLOOR_DATE, KLINE_FLOOR_DATE + timedelta(days=10), columns=["close_qfq"]
    )
    assert table.column_names == ["close_qfq"]
    assert table.num_rows == 5


@pytest.mark.integration
def test_get_universe_slice_across_two_codes(tmp_path: Path) -> None:
    bars = _make_bars("600000", 3) + _make_bars("000001", 3)
    factors = [_factor("600000", KLINE_FLOOR_DATE), _factor("000001", KLINE_FLOOR_DATE)]
    src = _FakeSource(bars, factors)
    repo = ParquetKlineRepo(root=tmp_path)
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    svc.sync_code("600000")
    svc.sync_code("000001")

    table = repo.get_universe_slice(
        ["600000", "000001"],
        KLINE_FLOOR_DATE,
        KLINE_FLOOR_DATE + timedelta(days=10),
        columns=["code", "close_qfq"],
    )
    assert table.column_names == ["code", "close_qfq"]
    assert table.num_rows == 6


@pytest.mark.integration
def test_universe_slice_unknown_column_rejected(tmp_path: Path) -> None:
    repo = ParquetKlineRepo(root=tmp_path)
    src = _FakeSource(_make_bars("600000", 1), [_factor("600000", KLINE_FLOOR_DATE)])
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    svc.sync_code("600000")

    with pytest.raises(Exception, match="unknown kline column"):
        repo.get_universe_slice(
            ["600000"], KLINE_FLOOR_DATE, KLINE_FLOOR_DATE, columns=["evil; DROP TABLE"]
        )


@pytest.mark.integration
def test_overwrite_then_upsert_keeps_sorted(tmp_path: Path) -> None:
    bars = _make_bars("600000", 5)
    factors = [_factor("600000", KLINE_FLOOR_DATE)]
    src = _FakeSource(bars, factors)
    repo = ParquetKlineRepo(root=tmp_path)
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    svc.sync_code("600000")
    last_first = repo.get_last_bar("600000")
    assert last_first is not None

    # Re-sync with extra bars — service routes to recompute, file stays sorted.
    src._bars = _make_bars("600000", 10)
    rep = svc.sync_code("600000")
    assert rep.mode == "recompute"
    assert rep.written_bars == 10

    table = repo.get_range("600000", KLINE_FLOOR_DATE, KLINE_FLOOR_DATE + timedelta(days=20))
    dates = [d for d in table.column("trade_date").to_pylist()]
    assert dates == sorted(dates)


@pytest.mark.integration
def test_sync_invalid_range_raises(tmp_path: Path) -> None:
    src = _FakeSource([], [])
    repo = ParquetKlineRepo(root=tmp_path)
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    with pytest.raises(QuantError, match="start"):
        svc.get_range("600000", date(2026, 5, 5), date(2026, 5, 1))


@pytest.mark.integration
def test_get_last_n_returns_tail(tmp_path: Path) -> None:
    src = _FakeSource(_make_bars("600000", 30), [_factor("600000", KLINE_FLOOR_DATE)])
    repo = ParquetKlineRepo(root=tmp_path)
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    svc.sync_code("600000")

    table = svc.get_last_n("600000", 5)
    assert table.num_rows == 5
