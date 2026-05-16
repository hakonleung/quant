"""Unit tests for :class:`StockMetaService`.

Uses an in-memory fake repo so the service logic (typed errors, batch
deduplication) is tested without parquet/pyarrow noise.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from quant_core.errors import QuantError
from quant_core.services.stock_meta_service import StockMetaService

from tests._util.stock_meta_fixtures import SEED, make_meta

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

    from quant_core.domain.types.stock import StockMeta


class _FakeRepo:
    def __init__(self, items: Iterable[StockMeta]) -> None:
        self._by_code: dict[str, StockMeta] = {m.code: m for m in items}

    def get(self, code: str) -> StockMeta | None:
        return self._by_code.get(code)

    def get_many(self, codes: Sequence[str]) -> list[StockMeta]:
        return [self._by_code[c] for c in codes if c in self._by_code]

    def list_by_industry(self, sw_l2: str) -> list[StockMeta]:
        return sorted(
            (m for m in self._by_code.values() if sw_l2 in m.industries),
            key=lambda m: m.code,
        )

    def list_all(self) -> list[StockMeta]:
        return sorted(self._by_code.values(), key=lambda m: m.code)


# Re-export for the rpc-ops test that uses this same fake.
__all__ = ["_FakeRepo"]


@pytest.fixture
def service() -> StockMetaService:
    return StockMetaService(_FakeRepo(SEED))


@pytest.mark.unit
class TestStockMetaServiceGet:
    def test_get_known_code(self, service: StockMetaService) -> None:
        assert service.get("600519") == SEED[0]

    def test_get_unknown_code_raises_typed_error(self, service: StockMetaService) -> None:
        with pytest.raises(QuantError) as excinfo:
            service.get("999999.SH")
        assert excinfo.value.code == "STOCK_NOT_FOUND"
        assert excinfo.value.details["code"] == "999999.SH"


@pytest.mark.unit
class TestStockMetaServiceGetBatch:
    def test_preserves_input_order(self, service: StockMetaService) -> None:
        got = service.get_batch(["000858", "600519"])
        assert [m.code for m in got] == ["000858", "600519"]

    def test_skips_missing_codes(self, service: StockMetaService) -> None:
        got = service.get_batch(["600519", "missing", "000858"])
        assert [m.code for m in got] == ["600519", "000858"]

    def test_deduplicates_codes_first_occurrence_wins(self, service: StockMetaService) -> None:
        got = service.get_batch(["600519", "000858", "600519"])
        assert [m.code for m in got] == ["600519", "000858"]

    def test_empty_input_returns_empty(self, service: StockMetaService) -> None:
        assert service.get_batch([]) == []


@pytest.mark.unit
class TestStockMetaServiceListByIndustry:
    def test_returns_sorted_by_code(self, service: StockMetaService) -> None:
        got = service.list_by_industry("白酒")
        assert [m.code for m in got] == ["000858", "600519"]

    def test_unknown_industry_returns_empty(self, service: StockMetaService) -> None:
        assert service.list_by_industry("not-an-industry") == []

    def test_empty_industry_string_raises(self, service: StockMetaService) -> None:
        with pytest.raises(QuantError) as excinfo:
            service.list_by_industry("")
        assert excinfo.value.code == "INVALID_ARGUMENT"

    def test_returns_freshly_added_stock_in_listing(self) -> None:
        # A new stock arriving via NestJS's writer (post storage-unify)
        # must be visible to the service on the next read — exercise
        # that by constructing a service over a repo that contains it.
        new = make_meta("600809", name="山西汾酒", industries="白酒")
        service = StockMetaService(_FakeRepo([*SEED, new]))
        got = service.list_by_industry("白酒")
        assert "600809" in {m.code for m in got}


@pytest.mark.unit
class TestStockMetaServiceListAll:
    def test_returns_all_sorted_by_code(self, service: StockMetaService) -> None:
        codes = [m.code for m in service.list_all()]
        assert codes == sorted(codes)
        assert set(codes) == {m.code for m in SEED}

    def test_empty_repo_returns_empty(self) -> None:
        empty = StockMetaService(_FakeRepo([]))
        assert empty.list_all() == []
