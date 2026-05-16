"""Integration tests for :class:`StockMetaSyncService`.

Wires a real :class:`ParquetStockMetaRepo` on a tmp path and a fake
source. Asserts the diff math (added / changed / unchanged) and the
fallback-chain interaction.

Storage-unify: the service no longer persists. Tests assert the
``report.upserts`` payload — the caller (NestJS) writes it.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

import pytest
from quant_cache.parquet_stock_meta_repo import ParquetStockMetaRepo
from quant_core.errors import QuantError
from quant_core.services.source_chain import RetryPolicy, SourceChain
from quant_core.services.stock_meta_sync_service import StockMetaSyncService

from tests._util.clock import FrozenClock
from tests._util.fake_source import FakeStockMetaSource
from tests._util.stock_meta_fixtures import SEED, make_meta

if TYPE_CHECKING:
    from pathlib import Path

    from quant_core.ports.stock_meta_source import StockMetaSource


def _no_sleep(_seconds: float) -> None:
    return None


@pytest.fixture
def repo(tmp_path: Path) -> ParquetStockMetaRepo:
    return ParquetStockMetaRepo(tmp_path / "stocks.parquet")


@pytest.fixture
def clock() -> FrozenClock:
    return FrozenClock(datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC))


def _make_service(
    sources: list[FakeStockMetaSource],
    repo: ParquetStockMetaRepo,
    clock: FrozenClock,
) -> StockMetaSyncService:
    typed_sources: list[StockMetaSource] = list(sources)
    chain: SourceChain[StockMetaSource] = SourceChain(
        typed_sources, retry=RetryPolicy(max_attempts=1), sleep=_no_sleep
    )
    return StockMetaSyncService(chain, repo, clock)


@pytest.mark.integration
class TestFullSyncReport:
    def test_first_sync_into_empty_repo_marks_all_as_added(
        self,
        repo: ParquetStockMetaRepo,
        clock: FrozenClock,
    ) -> None:
        source = FakeStockMetaSource(items=SEED)
        report = _make_service([source], repo, clock).run_full_sync()
        assert report.fetched == len(SEED)
        assert report.added == len(SEED)
        assert report.changed == 0
        assert report.unchanged == 0
        assert {m.code for m in report.upserts} == {m.code for m in SEED}

    def test_idempotent_resync_marks_everything_unchanged(
        self,
        repo: ParquetStockMetaRepo,
        clock: FrozenClock,
    ) -> None:
        # Seed the repo manually — service no longer writes.
        repo.upsert_many(SEED)
        source = FakeStockMetaSource(items=SEED)
        report = _make_service([source], repo, clock).run_full_sync()
        assert report.added == 0
        assert report.changed == 0
        assert report.unchanged == len(SEED)
        assert report.upserts == ()

    def test_changed_payload_counts_as_changed(
        self,
        repo: ParquetStockMetaRepo,
        clock: FrozenClock,
    ) -> None:
        repo.upsert_many(SEED)
        modified = make_meta("600519", name="MOUTAI v2", industries="白酒")
        rest = tuple(m for m in SEED if m.code != "600519")
        source = FakeStockMetaSource(items=(*rest, modified))
        report = _make_service([source], repo, clock).run_full_sync()
        assert report.changed == 1
        assert report.added == 0
        assert report.unchanged == len(SEED) - 1
        # The changed row appears in upserts; the rest are filtered out.
        assert {m.code for m in report.upserts} == {"600519"}


@pytest.mark.integration
class TestFallbackChain:
    def test_falls_back_to_secondary_when_primary_throws(
        self,
        repo: ParquetStockMetaRepo,
        clock: FrozenClock,
    ) -> None:
        primary = FakeStockMetaSource(
            name="primary",
            priority=1,
            fetch_error=QuantError("SOURCE_UNAVAILABLE", "down"),
        )
        secondary = FakeStockMetaSource(name="secondary", priority=2, items=SEED)
        report = _make_service([primary, secondary], repo, clock).run_full_sync()
        assert report.source == "secondary"
        assert report.fetched == len(SEED)


@pytest.mark.integration
class TestHealthcheckPassthrough:
    def test_returns_one_health_per_source(
        self,
        repo: ParquetStockMetaRepo,
        clock: FrozenClock,
    ) -> None:
        a = FakeStockMetaSource(name="a", priority=1, available=False)
        b = FakeStockMetaSource(name="b", priority=2, available=True)
        service = _make_service([a, b], repo, clock)
        healths = service.healthcheck_sources()
        names = [h.name for h in healths]
        assert names == ["a", "b"]
