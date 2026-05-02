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

    def upsert_many(self, items: Iterable[StockMeta]) -> None:
        for m in items:
            self._by_code[m.code] = m

    def get(self, code: str) -> StockMeta | None:
        return self._by_code.get(code)

    def get_many(self, codes: Sequence[str]) -> list[StockMeta]:
        return [self._by_code[c] for c in codes if c in self._by_code]

    def list_by_industry(self, sw_l2: str) -> list[StockMeta]:
        return sorted(
            (m for m in self._by_code.values() if m.industry_sw_l2 == sw_l2),
            key=lambda m: m.code,
        )


@pytest.fixture
def service() -> StockMetaService:
    return StockMetaService(_FakeRepo(SEED))


@pytest.mark.unit
class TestStockMetaServiceGet:
    def test_get_known_code(self, service: StockMetaService) -> None:
        assert service.get("600519.SH") == SEED[0]

    def test_get_unknown_code_raises_typed_error(self, service: StockMetaService) -> None:
        with pytest.raises(QuantError) as excinfo:
            service.get("999999.SH")
        assert excinfo.value.code == "STOCK_NOT_FOUND"
        assert excinfo.value.details["code"] == "999999.SH"


@pytest.mark.unit
class TestStockMetaServiceGetBatch:
    def test_preserves_input_order(self, service: StockMetaService) -> None:
        got = service.get_batch(["000858.SZ", "600519.SH"])
        assert [m.code for m in got] == ["000858.SZ", "600519.SH"]

    def test_skips_missing_codes(self, service: StockMetaService) -> None:
        got = service.get_batch(["600519.SH", "missing", "000858.SZ"])
        assert [m.code for m in got] == ["600519.SH", "000858.SZ"]

    def test_deduplicates_codes_first_occurrence_wins(self, service: StockMetaService) -> None:
        got = service.get_batch(["600519.SH", "000858.SZ", "600519.SH"])
        assert [m.code for m in got] == ["600519.SH", "000858.SZ"]

    def test_empty_input_returns_empty(self, service: StockMetaService) -> None:
        assert service.get_batch([]) == []


@pytest.mark.unit
class TestStockMetaServiceListByIndustry:
    def test_returns_sorted_by_code(self, service: StockMetaService) -> None:
        got = service.list_by_industry("白酒")
        assert [m.code for m in got] == ["000858.SZ", "600519.SH"]

    def test_unknown_industry_returns_empty(self, service: StockMetaService) -> None:
        assert service.list_by_industry("not-an-industry") == []

    def test_empty_industry_string_raises(self, service: StockMetaService) -> None:
        with pytest.raises(QuantError) as excinfo:
            service.list_by_industry("")
        assert excinfo.value.code == "INVALID_ARGUMENT"

    def test_added_stock_visible_in_listing(self, service: StockMetaService) -> None:
        new = make_meta("600809.SH", name="山西汾酒", industry_sw_l2="白酒")
        service._repo.upsert_many([new])
        got = service.list_by_industry("白酒")
        assert "600809.SH" in {m.code for m in got}
