"""Integration tests for :class:`StockMetaSyncService`.

Wires real adapters (FileKeyValueStore, ParquetStockMetaRepo) on tmp paths
and a fake source. Asserts the diff math, the fallback chain interaction,
and the persisted sync-state shape.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

import pytest
from quant_cache.file_kv_store import FileKeyValueStore
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
def kv(tmp_path: Path) -> FileKeyValueStore:
    return FileKeyValueStore(
        tmp_path / "kv",
        clock=FrozenClock(datetime(2026, 5, 1, tzinfo=UTC)),
    )


@pytest.fixture
def clock() -> FrozenClock:
    return FrozenClock(datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC))


def _make_service(
    sources: list[FakeStockMetaSource],
    repo: ParquetStockMetaRepo,
    kv: FileKeyValueStore,
    clock: FrozenClock,
) -> StockMetaSyncService:
    # `FakeStockMetaSource` structurally implements `StockMetaSource`; mypy
    # does not infer Protocol satisfaction across `SourceChain[T]`'s bound
    # so we widen via the generic parameter.

    typed_sources: list[StockMetaSource] = list(sources)
    chain: SourceChain[StockMetaSource] = SourceChain(
        typed_sources, retry=RetryPolicy(max_attempts=1), sleep=_no_sleep
    )
    return StockMetaSyncService(chain, repo, kv, clock)


@pytest.mark.integration
class TestFullSyncReport:
    def test_first_sync_into_empty_repo_marks_all_as_added(
        self,
        repo: ParquetStockMetaRepo,
        kv: FileKeyValueStore,
        clock: FrozenClock,
    ) -> None:
        source = FakeStockMetaSource(items=SEED)
        service = _make_service([source], repo, kv, clock)
        report = service.run_full_sync()
        assert report.fetched == len(SEED)
        assert report.added == len(SEED)
        assert report.changed == 0
        assert report.unchanged == 0
        assert {m.code for m in repo.list_all()} == {m.code for m in SEED}

    def test_idempotent_resync_marks_everything_unchanged(
        self,
        repo: ParquetStockMetaRepo,
        kv: FileKeyValueStore,
        clock: FrozenClock,
    ) -> None:
        source = FakeStockMetaSource(items=SEED)
        service = _make_service([source], repo, kv, clock)
        service.run_full_sync()
        report = service.run_full_sync()
        assert report.added == 0
        assert report.changed == 0
        assert report.unchanged == len(SEED)

    def test_changed_payload_counts_as_changed(
        self,
        repo: ParquetStockMetaRepo,
        kv: FileKeyValueStore,
        clock: FrozenClock,
    ) -> None:
        first = FakeStockMetaSource(items=SEED)
        _make_service([first], repo, kv, clock).run_full_sync()
        # New version of one stock with a different name → changed
        modified = make_meta("600519", name="MOUTAI v2", industries="白酒")
        rest = tuple(m for m in SEED if m.code != "600519")
        second = FakeStockMetaSource(items=(*rest, modified))
        report = _make_service([second], repo, kv, clock).run_full_sync()
        assert report.changed == 1
        assert report.added == 0
        assert report.unchanged == len(SEED) - 1
        assert repo.get("600519") == modified


@pytest.mark.integration
class TestSyncStatePersistence:
    def test_state_is_written_after_a_successful_sync(
        self,
        repo: ParquetStockMetaRepo,
        kv: FileKeyValueStore,
        clock: FrozenClock,
    ) -> None:
        source = FakeStockMetaSource(name="primary", items=SEED)
        service = _make_service([source], repo, kv, clock)
        service.run_full_sync()
        state = service.get_state()
        assert state is not None
        assert state.source == "primary"
        assert state.record_count == len(SEED)
        assert state.last_full_sync == "2026-05-01T12:00:00+00:00"

    def test_get_state_returns_none_before_first_sync(
        self,
        repo: ParquetStockMetaRepo,
        kv: FileKeyValueStore,
        clock: FrozenClock,
    ) -> None:
        service = _make_service([FakeStockMetaSource()], repo, kv, clock)
        assert service.get_state() is None

    def test_get_state_raises_on_corrupted_payload(
        self,
        repo: ParquetStockMetaRepo,
        kv: FileKeyValueStore,
        clock: FrozenClock,
    ) -> None:
        kv.put("stock_meta:sync_state", b"not json")
        service = _make_service([FakeStockMetaSource()], repo, kv, clock)
        with pytest.raises(QuantError) as excinfo:
            service.get_state()
        assert excinfo.value.code == "CACHE_CORRUPTED"


@pytest.mark.integration
class TestFallbackChain:
    def test_falls_back_to_secondary_when_primary_throws(
        self,
        repo: ParquetStockMetaRepo,
        kv: FileKeyValueStore,
        clock: FrozenClock,
    ) -> None:
        primary = FakeStockMetaSource(
            name="primary",
            priority=1,
            fetch_error=QuantError("SOURCE_UNAVAILABLE", "down"),
        )
        secondary = FakeStockMetaSource(name="secondary", priority=2, items=SEED)
        service = _make_service([primary, secondary], repo, kv, clock)
        report = service.run_full_sync()
        assert report.source == "secondary"
        assert report.fetched == len(SEED)


@pytest.mark.integration
class TestHealthcheckPassthrough:
    def test_returns_one_health_per_source(
        self,
        repo: ParquetStockMetaRepo,
        kv: FileKeyValueStore,
        clock: FrozenClock,
    ) -> None:
        a = FakeStockMetaSource(name="a", priority=1, available=False)
        b = FakeStockMetaSource(name="b", priority=2, available=True)
        service = _make_service([a, b], repo, kv, clock)
        healths = service.healthcheck_sources()
        names = [h.name for h in healths]
        assert names == ["a", "b"]
