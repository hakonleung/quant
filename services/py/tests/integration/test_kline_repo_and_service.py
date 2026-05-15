"""Integration tests for FlatPrefixKlineRepo + KlineService.

Uses a fake :class:`KlineSource` so we never hit the network. Real
parquet IO + DuckDB go through the actual disk. Since the service no
longer writes (NestJS owns persistence), tests that need data in the
repo seed via :func:`seed_kline_parquet` after a `sync_code` call.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from quant_cache.flat_prefix_kline_repo import FlatPrefixKlineRepo
from quant_core.domain.types.kline import KLINE_FLOOR_DATE, AdjFactor, RawDailyBar
from quant_core.errors import QuantError
from quant_core.services.kline_service import KlineService

from tests._util.kline_seeder import seed_kline_parquet

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
def test_backfill_returns_bars_for_writer(tmp_path: Path) -> None:
    """``sync_code`` returns the assembled bars; persistence is the
    caller's job (NestJS-side ``KlineWriterService``)."""
    bars = _make_bars("600000", 65)
    factors = [_factor("600000", KLINE_FLOOR_DATE)]
    src = _FakeSource(bars, factors)
    repo = FlatPrefixKlineRepo(root=tmp_path)
    clock = _FakeClock(datetime(2026, 5, 1, tzinfo=UTC))
    svc = KlineService(src, repo, clock)

    rep, assembled = svc.sync_code("600000")
    assert rep.mode == "backfill"
    assert rep.written_bars == 65
    assert len(assembled) == 65
    assert assembled[-1].ma60 is not None  # 60-day MA fully populated by row 60+


@pytest.mark.integration
def test_get_range_projects_close_qfq_only(tmp_path: Path) -> None:
    src = _FakeSource(_make_bars("600000", 5), [_factor("600000", KLINE_FLOOR_DATE)])
    repo = FlatPrefixKlineRepo(root=tmp_path)
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    _, bars = svc.sync_code("600000")
    seed_kline_parquet(tmp_path, bars)

    table = repo.get_range(
        "600000", KLINE_FLOOR_DATE, KLINE_FLOOR_DATE + timedelta(days=10), columns=["close_qfq"]
    )
    assert table.column_names == ["close_qfq"]
    assert table.num_rows == 5


@pytest.mark.integration
def test_get_universe_slice_across_two_codes(tmp_path: Path) -> None:
    bars_all = _make_bars("600000", 3) + _make_bars("000001", 3)
    factors = [_factor("600000", KLINE_FLOOR_DATE), _factor("000001", KLINE_FLOOR_DATE)]
    src = _FakeSource(bars_all, factors)
    repo = FlatPrefixKlineRepo(root=tmp_path)
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    for code in ("600000", "000001"):
        _, bars = svc.sync_code(code)
        seed_kline_parquet(tmp_path, bars)

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
    repo = FlatPrefixKlineRepo(root=tmp_path)
    src = _FakeSource(_make_bars("600000", 1), [_factor("600000", KLINE_FLOOR_DATE)])
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    _, bars = svc.sync_code("600000")
    seed_kline_parquet(tmp_path, bars)

    with pytest.raises(Exception, match="unknown kline column"):
        repo.get_universe_slice(
            ["600000"], KLINE_FLOOR_DATE, KLINE_FLOOR_DATE, columns=["evil; DROP TABLE"]
        )


@pytest.mark.integration
def test_recompute_returns_full_history(tmp_path: Path) -> None:
    """When ``sync_code`` runs against an existing watermark, the
    incremental path re-fetches the whole window and returns it."""
    bars = _make_bars("600000", 5)
    factors = [_factor("600000", KLINE_FLOOR_DATE)]
    src = _FakeSource(bars, factors)
    repo = FlatPrefixKlineRepo(root=tmp_path)
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    _, first = svc.sync_code("600000")
    seed_kline_parquet(tmp_path, first)
    assert repo.last_trade_date("600000") == first[-1].trade_date

    # Re-sync with extra bars — service routes to recompute path.
    src._bars = _make_bars("600000", 10)
    rep, second = svc.sync_code("600000")
    assert rep.mode == "recompute"
    assert rep.written_bars == 10
    assert len(second) == 10
    assert [b.trade_date for b in second] == sorted(b.trade_date for b in second)


@pytest.mark.integration
def test_sync_invalid_range_raises(tmp_path: Path) -> None:
    src = _FakeSource([], [])
    repo = FlatPrefixKlineRepo(root=tmp_path)
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    with pytest.raises(QuantError, match="start"):
        svc.get_range("600000", date(2026, 5, 5), date(2026, 5, 1))


@pytest.mark.integration
def test_get_last_n_returns_tail(tmp_path: Path) -> None:
    src = _FakeSource(_make_bars("600000", 30), [_factor("600000", KLINE_FLOOR_DATE)])
    repo = FlatPrefixKlineRepo(root=tmp_path)
    svc = KlineService(src, repo, _FakeClock(datetime(2026, 5, 1, tzinfo=UTC)))
    _, bars = svc.sync_code("600000")
    seed_kline_parquet(tmp_path, bars)

    table = svc.get_last_n("600000", 5)
    assert table.num_rows == 5
