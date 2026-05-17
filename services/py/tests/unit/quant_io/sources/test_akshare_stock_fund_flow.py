"""Unit tests for ``AKShareFundFlowRankSource`` (10jqka adapter)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from quant_core.errors import QuantError
from quant_io.sources.akshare_stock_fund_flow import AKShareFundFlowRankSource


class _FakeGateway:
    """Fake exposing ``stock_fund_flow_individual`` only."""

    def __init__(self, by_symbol: dict[str, list[dict[str, object]]]) -> None:
        self._by_symbol = by_symbol
        self.calls: list[str] = []

    def stock_fund_flow_individual(self, symbol: str) -> list[dict[str, object]]:
        self.calls.append(symbol)
        return list(self._by_symbol.get(symbol, []))


def _row(code: object, *, inflow: object) -> dict[str, object]:
    return {
        "序号": 1,
        "股票代码": code,
        "股票简称": "测试",
        "最新价": 10.0,
        "阶段涨跌幅": "0%",
        "连续换手率": "0%",
        "资金流入净额": inflow,
    }


class TestFetchRank:
    def test_parses_yi_unit_into_yuan(self) -> None:
        gw = _FakeGateway({"3日排行": [_row(600519, inflow="3.5亿")]})
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(3)
        assert out == {"600519": Decimal("350000000")}
        assert gw.calls == ["3日排行"]

    def test_parses_wan_unit_signed(self) -> None:
        gw = _FakeGateway(
            {
                "5日排行": [
                    _row(600519, inflow="-6043.55万"),
                    _row(300750, inflow="1234.5万"),
                ],
            }
        )
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(5)
        assert out == {
            "600519": Decimal("-60435500"),
            "300750": Decimal("12345000"),
        }

    def test_parses_bare_yuan_value(self) -> None:
        gw = _FakeGateway({"3日排行": [_row(600519, inflow="-678")]})
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(3)
        assert out == {"600519": Decimal("-678")}

    def test_zero_pads_int_codes(self) -> None:
        # Shenzhen / Beijing codes lose leading zeros through pandas.
        gw = _FakeGateway(
            {
                "10日排行": [
                    _row(1393, inflow="100万"),
                    _row(300750, inflow="200万"),
                    _row(688041, inflow="300万"),
                ],
            }
        )
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(10)
        assert sorted(out) == ["001393", "300750", "688041"]

    def test_supports_20_day_window(self) -> None:
        gw = _FakeGateway({"20日排行": [_row(600519, inflow="-1.5亿")]})
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(20)
        assert out == {"600519": Decimal("-150000000")}

    def test_double_dash_becomes_none(self) -> None:
        gw = _FakeGateway({"5日排行": [_row(600519, inflow="--")]})
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(5)
        assert out == {"600519": None}

    def test_drops_non_six_digit_codes(self) -> None:
        gw = _FakeGateway(
            {
                "10日排行": [
                    _row(600519, inflow="100万"),
                    _row("AAPL", inflow="200万"),
                    _row(99_999_999, inflow="300万"),  # out of A-share range
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
            def stock_fund_flow_individual(self, symbol: str) -> object:
                raise RuntimeError(f"http 503 on {symbol}")

        src = AKShareFundFlowRankSource(gateway=_ExplodingGateway())
        with pytest.raises(QuantError) as exc:
            src.fetch_rank(20)
        assert exc.value.code == "SOURCE_UNAVAILABLE"
        assert "http 503" in str(exc.value)

    def test_garbled_value_yields_none_not_crash(self) -> None:
        gw = _FakeGateway({"3日排行": [_row(600519, inflow="abc")]})
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(3)
        assert out == {"600519": None}

    def test_comma_thousands_separator_parsed(self) -> None:
        gw = _FakeGateway({"3日排行": [_row(600519, inflow="1,234.5万")]})
        out = AKShareFundFlowRankSource(gateway=gw).fetch_rank(3)
        assert out == {"600519": Decimal("12345000")}
