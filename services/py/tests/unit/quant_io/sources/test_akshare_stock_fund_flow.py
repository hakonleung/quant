"""Unit tests for ``AKShareFundFlowRankSource``."""

from __future__ import annotations

from decimal import Decimal

import pytest

from quant_core.errors import QuantError
from quant_io.sources.akshare_stock_fund_flow import AKShareFundFlowRankSource


class _FakeGateway:
    """Fake exposing ``stock_individual_fund_flow_rank`` only."""

    def __init__(self, by_indicator: dict[str, list[dict[str, object]]]) -> None:
        self._by_indicator = by_indicator
        self.calls: list[str] = []

    def stock_individual_fund_flow_rank(self, indicator: str) -> list[dict[str, object]]:
        self.calls.append(indicator)
        return list(self._by_indicator.get(indicator, []))


def _row(code: str, *, indicator: str, inflow: str | None) -> dict[str, object]:
    return {
        "代码": code,
        f"{indicator}主力净流入-净额": "--" if inflow is None else inflow,
    }


class TestFetchRank:
    def test_returns_main_net_inflow_for_each_row(self) -> None:
        gw = _FakeGateway(
            {
                "3日": [
                    _row("600519", indicator="3日", inflow="300000000"),
                    _row("000001", indicator="3日", inflow="-150000000"),
                ],
            }
        )
        src = AKShareFundFlowRankSource(gateway=gw)
        out = src.fetch_rank(3)
        assert out == {"600519": Decimal("300000000"), "000001": Decimal("-150000000")}
        assert gw.calls == ["3日"]

    def test_double_dash_becomes_none(self) -> None:
        gw = _FakeGateway({"5日": [_row("600519", indicator="5日", inflow=None)]})
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(5)
        assert out == {"600519": None}

    def test_drops_non_six_digit_codes(self) -> None:
        gw = _FakeGateway(
            {
                "10日": [
                    _row("600519", indicator="10日", inflow="100"),
                    {"代码": "AAPL", "10日主力净流入-净额": "200"},
                    {"代码": "12345", "10日主力净流入-净额": "300"},
                ],
            }
        )
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(10)
        assert list(out) == ["600519"]

    def test_invalid_window_raises(self) -> None:
        src = AKShareFundFlowRankSource(gateway=_FakeGateway({}))
        with pytest.raises(QuantError) as exc:
            src.fetch_rank(7)
        assert exc.value.code == "INVALID_ARGUMENT"

    def test_gateway_exception_translates_to_source_unavailable(self) -> None:
        class _ExplodingGateway:
            def stock_individual_fund_flow_rank(self, indicator: str) -> object:
                raise RuntimeError(f"http 503 on {indicator}")

        src = AKShareFundFlowRankSource(gateway=_ExplodingGateway())
        with pytest.raises(QuantError) as exc:
            src.fetch_rank(20)
        assert exc.value.code == "SOURCE_UNAVAILABLE"
        assert "http 503" in str(exc.value)

    def test_accepts_stock_code_alias_column(self) -> None:
        # The endpoint historically returned `股票代码`; we accept either
        # spelling for resilience.
        gw = _FakeGateway(
            {
                "3日": [{"股票代码": "600519", "3日主力净流入-净额": "100"}],
            }
        )
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(3)
        assert out == {"600519": Decimal("100")}

    def test_garbled_decimal_yields_none_not_crash(self) -> None:
        gw = _FakeGateway(
            {
                "3日": [
                    {"代码": "600519", "3日主力净流入-净额": "abc"},
                ],
            }
        )
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(3)
        assert out == {"600519": None}
