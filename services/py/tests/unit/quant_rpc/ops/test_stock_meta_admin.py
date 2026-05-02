"""Unit tests for the stock-meta admin Flight ops."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

import pytest
from quant_cache.file_kv_store import FileKeyValueStore
from quant_cache.parquet_stock_meta_repo import ParquetStockMetaRepo
from quant_core.services.source_chain import RetryPolicy, SourceChain
from quant_core.services.stock_meta_sync_service import StockMetaSyncService
from quant_rpc.ops.stock_meta_admin import (
    SOURCE_HEALTH_SCHEMA,
    SYNC_REPORT_SCHEMA,
    CheckSourcesHandler,
    SyncFullHandler,
)

from tests._util.clock import FrozenClock
from tests._util.fake_source import FakeStockMetaSource
from tests._util.stock_meta_fixtures import SEED

if TYPE_CHECKING:
    from pathlib import Path

    from quant_core.ports.stock_meta_source import StockMetaSource


def _no_sleep(_seconds: float) -> None:
    return None


def _service(
    sources: list[FakeStockMetaSource],
    tmp_path: Path,
) -> StockMetaSyncService:
    typed: list[StockMetaSource] = list(sources)
    chain: SourceChain[StockMetaSource] = SourceChain(
        typed, retry=RetryPolicy(max_attempts=1), sleep=_no_sleep
    )
    repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kv = FileKeyValueStore(tmp_path / "kv", clock=FrozenClock(datetime(2026, 5, 1, tzinfo=UTC)))
    return StockMetaSyncService(chain, repo, kv, FrozenClock(datetime(2026, 5, 1, tzinfo=UTC)))


@pytest.mark.unit
class TestCheckSourcesHandler:
    def test_op_and_schema(self, tmp_path: Path) -> None:
        h = CheckSourcesHandler(_service([FakeStockMetaSource()], tmp_path))
        assert h.op == "check_stock_meta_sources"
        assert h.schema == SOURCE_HEALTH_SCHEMA

    def test_returns_one_row_per_source_in_priority_order(self, tmp_path: Path) -> None:
        a = FakeStockMetaSource(name="a", priority=2, available=True)
        b = FakeStockMetaSource(name="b", priority=1, available=False)
        h = CheckSourcesHandler(_service([a, b], tmp_path))
        table = h.execute({})
        names = table.column("name").to_pylist()
        assert names == ["b", "a"]
        avail = table.column("available").to_pylist()
        assert avail == [False, True]
        # Unavailable source reports its reason in last_error.
        last_error = table.column("last_error").to_pylist()
        assert last_error[0]  # non-empty
        assert last_error[1] == ""

    def test_unavailable_source_uses_minus_one_for_unknown_metrics(self, tmp_path: Path) -> None:
        h = CheckSourcesHandler(
            _service([FakeStockMetaSource(name="x", available=False)], tmp_path)
        )
        table = h.execute({})
        assert table.column("latency_ms").to_pylist() == [-1]
        assert table.column("quota_remaining").to_pylist() == [-1]


@pytest.mark.unit
class TestSyncFullHandler:
    def test_op_and_schema(self, tmp_path: Path) -> None:
        h = SyncFullHandler(_service([FakeStockMetaSource()], tmp_path))
        assert h.op == "sync_stock_meta_full"
        assert h.schema == SYNC_REPORT_SCHEMA

    def test_first_sync_returns_added_count(self, tmp_path: Path) -> None:
        source = FakeStockMetaSource(name="primary", items=SEED)
        h = SyncFullHandler(_service([source], tmp_path))
        table = h.execute({})
        assert table.num_rows == 1
        row = table.to_pylist()[0]
        assert row["source"] == "primary"
        assert row["fetched"] == len(SEED)
        assert row["added"] == len(SEED)
        assert row["changed"] == 0
        assert row["unchanged"] == 0
