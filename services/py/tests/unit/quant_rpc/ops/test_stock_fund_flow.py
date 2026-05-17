"""Unit tests for ``list_stock_fund_flow_ranks`` Flight op."""

from __future__ import annotations

from decimal import Decimal

import pytest

from quant_core.errors import QuantError
from quant_rpc.ops.stock_fund_flow import (
    STOCK_FUND_FLOW_RANK_SCHEMA,
    ListStockFundFlowRanksHandler,
)


class _StubSource:
    """Pre-canned per-window data, mirroring ``AKShareFundFlowRankSource.fetch_rank``."""

    def __init__(self, by_window: dict[int, dict[str, Decimal | None]]) -> None:
        self._by_window = by_window
        self.calls: list[int] = []

    def fetch_rank(self, window: int) -> dict[str, Decimal | None]:
        self.calls.append(window)
        return dict(self._by_window.get(window, {}))


class TestListStockFundFlowRanksHandler:
    def test_default_windows_emit_full_block(self) -> None:
        source = _StubSource(
            {
                3: {"600519": Decimal("3")},
                5: {"600519": Decimal("5")},
                10: {"600519": Decimal("10")},
                20: {"600519": Decimal("20")},
            }
        )
        handler = ListStockFundFlowRanksHandler(source)
        table = handler.execute({})
        assert table.schema == STOCK_FUND_FLOW_RANK_SCHEMA
        assert table.num_rows == 1
        row = table.to_pylist()[0]
        assert row == {
            "code": "600519",
            "main_net_inflow_3d": "3",
            "main_net_inflow_5d": "5",
            "main_net_inflow_10d": "10",
            "main_net_inflow_20d": "20",
        }
        assert source.calls == [3, 5, 10, 20]

    def test_outer_join_missing_windows_become_null(self) -> None:
        source = _StubSource(
            {
                3: {"600519": Decimal("3"), "000001": Decimal("9")},
                5: {"600519": Decimal("5")},
                10: {},
                20: {"000001": Decimal("20")},
            }
        )
        out = ListStockFundFlowRanksHandler(source).execute({}).to_pylist()
        # Sorted by code → ['000001', '600519']
        assert [r["code"] for r in out] == ["000001", "600519"]
        # 000001: 3d=9, 20d=20, others null
        assert out[0]["main_net_inflow_3d"] == "9"
        assert out[0]["main_net_inflow_5d"] is None
        assert out[0]["main_net_inflow_10d"] is None
        assert out[0]["main_net_inflow_20d"] == "20"
        # 600519: 3d/5d filled, 10d/20d null
        assert out[1]["main_net_inflow_10d"] is None
        assert out[1]["main_net_inflow_20d"] is None

    def test_codes_with_all_null_windows_are_dropped(self) -> None:
        source = _StubSource(
            {
                3: {"600519": None},
                5: {"600519": None},
                10: {"600519": None},
                20: {"600519": None, "000001": Decimal("1")},
            }
        )
        out = ListStockFundFlowRanksHandler(source).execute({}).to_pylist()
        assert [r["code"] for r in out] == ["000001"]

    def test_empty_universe_returns_empty_table(self) -> None:
        table = ListStockFundFlowRanksHandler(_StubSource({})).execute({})
        assert table.num_rows == 0
        assert table.schema == STOCK_FUND_FLOW_RANK_SCHEMA

    def test_explicit_windows_subset(self) -> None:
        source = _StubSource(
            {
                3: {"600519": Decimal("3")},
                10: {"600519": Decimal("10")},
            }
        )
        table = ListStockFundFlowRanksHandler(source).execute({"windows": [3, 10]})
        assert table.schema.names == ["code", "main_net_inflow_3d", "main_net_inflow_10d"]
        assert source.calls == [3, 10]

    def test_rejects_unknown_window(self) -> None:
        with pytest.raises(QuantError) as exc:
            ListStockFundFlowRanksHandler(_StubSource({})).execute({"windows": [7]})
        assert exc.value.code == "INVALID_ARGUMENT"

    def test_rejects_non_list_windows(self) -> None:
        with pytest.raises(QuantError) as exc:
            ListStockFundFlowRanksHandler(_StubSource({})).execute({"windows": "3"})
        assert exc.value.code == "INVALID_ARGUMENT"

    def test_rejects_non_int_windows_entries(self) -> None:
        with pytest.raises(QuantError) as exc:
            ListStockFundFlowRanksHandler(_StubSource({})).execute({"windows": ["3"]})
        assert exc.value.code == "INVALID_ARGUMENT"

    def test_rejects_empty_windows_list(self) -> None:
        with pytest.raises(QuantError) as exc:
            ListStockFundFlowRanksHandler(_StubSource({})).execute({"windows": []})
        assert exc.value.code == "INVALID_ARGUMENT"

    def test_dedupes_repeated_windows(self) -> None:
        source = _StubSource({3: {"600519": Decimal("3")}})
        table = ListStockFundFlowRanksHandler(source).execute({"windows": [3, 3, 3]})
        assert source.calls == [3]
        assert table.schema.names == ["code", "main_net_inflow_3d"]
