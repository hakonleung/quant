"""Unit tests for the stock-meta Flight ops.

Verifies the args validation + table shape returned by each handler. The
underlying repo is in-memory so we don't drag pyarrow disk IO into a unit
test.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from quant_cache.stock_meta_schema import STOCK_META_SCHEMA
from quant_core.errors import QuantError
from quant_core.services.stock_meta_service import StockMetaService
from quant_rpc.ops.stock_meta import GetStockMetaBatchHandler, ListByIndustryHandler

from tests._util.stock_meta_fixtures import SEED

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

    from quant_core.domain.types.stock import StockMeta


class _FakeRepo:
    def __init__(self, items: Iterable[StockMeta]) -> None:
        self._by_code: dict[str, StockMeta] = {m.code: m for m in items}

    def upsert_many(self, items: Iterable[StockMeta]) -> None:  # pragma: no cover
        for m in items:
            self._by_code[m.code] = m

    def get(self, code: str) -> StockMeta | None:  # pragma: no cover
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
class TestGetStockMetaBatchHandler:
    def test_op_and_schema(self, service: StockMetaService) -> None:
        h = GetStockMetaBatchHandler(service)
        assert h.op == "get_stock_meta_batch"
        assert h.schema == STOCK_META_SCHEMA

    def test_returns_one_row_per_resolved_code(self, service: StockMetaService) -> None:
        h = GetStockMetaBatchHandler(service)
        table = h.execute({"codes": ["600519.SH", "000858.SZ"]})
        assert table.num_rows == 2
        assert table.column("code").to_pylist() == ["600519.SH", "000858.SZ"]
        assert table.schema == STOCK_META_SCHEMA

    def test_missing_codes_dropped(self, service: StockMetaService) -> None:
        h = GetStockMetaBatchHandler(service)
        table = h.execute({"codes": ["600519.SH", "missing"]})
        assert table.column("code").to_pylist() == ["600519.SH"]

    def test_empty_codes_returns_empty_table_with_schema(self, service: StockMetaService) -> None:
        h = GetStockMetaBatchHandler(service)
        table = h.execute({"codes": []})
        assert table.num_rows == 0
        assert table.schema == STOCK_META_SCHEMA

    def test_codes_missing_raises_invalid_argument(self, service: StockMetaService) -> None:
        h = GetStockMetaBatchHandler(service)
        with pytest.raises(QuantError) as excinfo:
            h.execute({})
        assert excinfo.value.code == "INVALID_ARGUMENT"

    def test_codes_not_a_list_raises(self, service: StockMetaService) -> None:
        h = GetStockMetaBatchHandler(service)
        with pytest.raises(QuantError) as excinfo:
            h.execute({"codes": "600519.SH"})
        assert excinfo.value.code == "INVALID_ARGUMENT"

    def test_codes_contains_non_string_raises(self, service: StockMetaService) -> None:
        h = GetStockMetaBatchHandler(service)
        with pytest.raises(QuantError) as excinfo:
            h.execute({"codes": ["600519.SH", 42]})
        assert excinfo.value.code == "INVALID_ARGUMENT"
        assert excinfo.value.details["index"] == 1


@pytest.mark.unit
class TestListByIndustryHandler:
    def test_op_and_schema(self, service: StockMetaService) -> None:
        h = ListByIndustryHandler(service)
        assert h.op == "list_stock_meta_by_industry"
        assert h.schema == STOCK_META_SCHEMA

    def test_returns_industry_members_sorted(self, service: StockMetaService) -> None:
        h = ListByIndustryHandler(service)
        table = h.execute({"sw_l2": "白酒"})
        assert table.column("code").to_pylist() == ["000858.SZ", "600519.SH"]

    def test_unknown_industry_returns_empty(self, service: StockMetaService) -> None:
        h = ListByIndustryHandler(service)
        table = h.execute({"sw_l2": "not-an-industry"})
        assert table.num_rows == 0

    def test_sw_l2_missing_raises(self, service: StockMetaService) -> None:
        h = ListByIndustryHandler(service)
        with pytest.raises(QuantError) as excinfo:
            h.execute({})
        assert excinfo.value.code == "INVALID_ARGUMENT"

    def test_sw_l2_empty_string_raises(self, service: StockMetaService) -> None:
        h = ListByIndustryHandler(service)
        with pytest.raises(QuantError) as excinfo:
            h.execute({"sw_l2": ""})
        assert excinfo.value.code == "INVALID_ARGUMENT"
