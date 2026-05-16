"""Integration tests for :class:`ParquetStockMetaRepo`.

Exercises the adapter against a real parquet file on tmp_path: the codec
round-trip, ordering guarantees, and the business-flavoured queries
(``get_many`` order/skip semantics, ``list_by_industry``).

The repo is read-only post-storage-unify-rollout; tests seed via
:func:`seed_stock_meta_parquet` (direct ``pyarrow`` write through the
shared codec), which is exactly the on-disk shape NestJS's writer
produces.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from quant_cache.parquet_stock_meta_repo import ParquetStockMetaRepo

from tests._util.stock_meta_fixtures import SEED
from tests._util.stock_meta_seeder import seed_stock_meta_parquet

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture
def repo(tmp_path: Path) -> ParquetStockMetaRepo:
    path = tmp_path / "stocks.parquet"
    seed_stock_meta_parquet(path, SEED)
    return ParquetStockMetaRepo(path)


@pytest.mark.integration
class TestParquetStockMetaRepo:
    def test_get_round_trip(self, repo: ParquetStockMetaRepo) -> None:
        got = repo.get("600519")
        assert got is not None
        assert got == SEED[0]

    def test_get_missing_returns_none(self, repo: ParquetStockMetaRepo) -> None:
        assert repo.get("999999.SH") is None

    def test_get_many_preserves_input_order(self, repo: ParquetStockMetaRepo) -> None:
        got = repo.get_many(["000858", "600519"])
        assert [m.code for m in got] == ["000858", "600519"]

    def test_get_many_skips_missing_codes(self, repo: ParquetStockMetaRepo) -> None:
        got = repo.get_many(["600519", "missing", "000858"])
        assert [m.code for m in got] == ["600519", "000858"]

    def test_get_many_empty_input_returns_empty(self, repo: ParquetStockMetaRepo) -> None:
        assert repo.get_many([]) == []

    def test_list_by_industry_filters_and_sorts(self, repo: ParquetStockMetaRepo) -> None:
        got = repo.list_by_industry("白酒")
        assert [m.code for m in got] == ["000858", "600519"]

    def test_list_by_industry_unknown_returns_empty(self, repo: ParquetStockMetaRepo) -> None:
        assert repo.list_by_industry("not-an-industry") == []

    def test_list_all_returns_every_stock_sorted_by_code(
        self, repo: ParquetStockMetaRepo
    ) -> None:
        codes = [m.code for m in repo.list_all()]
        assert codes == sorted(codes)
        assert set(codes) == {m.code for m in SEED}

    def test_list_all_returns_empty_for_fresh_repo(self, tmp_path: Path) -> None:
        empty = ParquetStockMetaRepo(tmp_path / "empty.parquet")
        assert empty.list_all() == []

    def test_persists_across_repo_instances(self, tmp_path: Path) -> None:
        path = tmp_path / "stocks.parquet"
        seed_stock_meta_parquet(path, SEED)
        again = ParquetStockMetaRepo(path)
        assert again.get("600519") == SEED[0]
