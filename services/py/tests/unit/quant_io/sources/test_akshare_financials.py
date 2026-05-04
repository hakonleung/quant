"""Unit tests for ``AKShareFinancialsBulkSource`` + per-stock enricher.

The fake gateway lets us exercise the YTD-to-single-quarter conversion
without touching akshare. Each test seeds one or two periods of bulk
data and asserts the derived quarterly values match by-hand math.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from quant_core.errors import QuantError
from quant_io.sources.akshare_financials import (
    AKShareFinancialsBulkSource,
    AKShareFinancialsPerStockEnricher,
)


class _FakeBulkGateway:
    """Fake exposing only ``stock_yjbb_em`` for the bulk source."""

    def __init__(self, by_period: dict[str, list[dict[str, object]]]) -> None:
        self._by_period = by_period
        self.calls: list[str] = []

    def stock_yjbb_em(self, date: str) -> list[dict[str, object]]:  # noqa: A002 — match akshare
        self.calls.append(date)
        return list(self._by_period.get(date, []))

    # Required by the Protocol but unused here — mark with stub bodies.
    def stock_individual_info_em(self, symbol: str) -> object:
        raise AssertionError("not used by bulk source")

    def stock_financial_abstract_ths(self, symbol: str) -> object:
        raise AssertionError("not used by bulk source")


def _row(code: str, *, revenue_ytd: str | None, np_ytd: str | None, eps: str | None) -> dict[str, object]:
    return {
        "股票代码": code,
        "营业总收入": revenue_ytd,
        "净利润-净利润": np_ytd,
        "每股净资产": eps,
    }


# ---- Bulk source: YTD → single-quarter conversion -----------------------


class TestBulkYtdToSingle:
    def test_q1_keeps_ytd_as_single_value(self) -> None:
        gw = _FakeBulkGateway(
            {
                "20250331": [_row("600519", revenue_ytd="100", np_ytd="40", eps="20")],
            }
        )
        src = AKShareFinancialsBulkSource(gateway=gw)
        out = src.fetch_recent(today=date(2025, 4, 1), quarters=8)
        payload = out["600519"]
        assert len(payload.quarterlies) == 1
        q = payload.quarterlies[0]
        assert q.period == date(2025, 3, 31)
        assert q.revenue == Decimal("100")
        assert q.net_profit == Decimal("40")
        assert payload.net_assets_per_share == Decimal("20")
        assert payload.net_assets_period == date(2025, 3, 31)

    def test_q2_subtracts_q1_in_same_year(self) -> None:
        gw = _FakeBulkGateway(
            {
                "20250331": [_row("600519", revenue_ytd="100", np_ytd="40", eps=None)],
                "20250630": [_row("600519", revenue_ytd="220", np_ytd="100", eps="22")],
            }
        )
        src = AKShareFinancialsBulkSource(gateway=gw)
        out = src.fetch_recent(today=date(2025, 7, 1), quarters=8)
        qs = out["600519"].quarterlies
        # Q1: 100 / 40; Q2 single: 120 / 60
        assert [q.period for q in qs] == [date(2025, 3, 31), date(2025, 6, 30)]
        assert qs[1].revenue == Decimal("120")
        assert qs[1].net_profit == Decimal("60")

    def test_year_boundary_does_not_subtract_across_years(self) -> None:
        # Q1 2025 must not subtract Q4 2024 (different fiscal years).
        gw = _FakeBulkGateway(
            {
                "20241231": [_row("600519", revenue_ytd="500", np_ytd="200", eps=None)],
                "20250331": [_row("600519", revenue_ytd="80", np_ytd="30", eps=None)],
            }
        )
        src = AKShareFinancialsBulkSource(gateway=gw)
        out = src.fetch_recent(today=date(2025, 4, 1), quarters=8)
        qs = out["600519"].quarterlies
        # Q4 2024 single = YTD - Q3 2024 YTD; Q3 missing → drop Q4 2024.
        # Q1 2025 keeps YTD = 80 / 30.
        assert [q.period for q in qs] == [date(2025, 3, 31)]
        assert qs[0].revenue == Decimal("80")
        assert qs[0].net_profit == Decimal("30")

    def test_keep_quarters_caps_output_window(self) -> None:
        # Seed every quarter end the source might enumerate so the only
        # thing limiting the output is the explicit `quarters=4` cap.
        keys = [
            "20231231",
            "20240331",
            "20240630",
            "20240930",
            "20241231",
            "20250331",
            "20250630",
            "20250930",
            "20231231",  # repetition is harmless — dict overrides
        ]
        rows: dict[str, list[dict[str, object]]] = {}
        for i, key in enumerate(keys):
            rows[key] = [
                _row("600519", revenue_ytd=str((i + 1) * 10), np_ytd=str((i + 1) * 5), eps=None)
            ]
        gw = _FakeBulkGateway(rows)
        src = AKShareFinancialsBulkSource(gateway=gw)
        out = src.fetch_recent(today=date(2025, 10, 1), quarters=4)
        assert len(out["600519"].quarterlies) <= 4

    def test_invalid_code_skipped(self) -> None:
        gw = _FakeBulkGateway(
            {"20250331": [_row("ABCDEF", revenue_ytd="10", np_ytd="5", eps=None)]}
        )
        src = AKShareFinancialsBulkSource(gateway=gw)
        out = src.fetch_recent(today=date(2025, 4, 1), quarters=8)
        assert out == {}

    def test_total_failure_raises_source_unavailable(self) -> None:
        class _Boom:
            def stock_yjbb_em(self, date: str) -> object:  # noqa: A002, ARG002
                raise RuntimeError("upstream down")

            def stock_individual_info_em(self, symbol: str) -> object:  # noqa: ARG002
                return []

            def stock_financial_abstract_ths(self, symbol: str) -> object:  # noqa: ARG002
                return []

        src = AKShareFinancialsBulkSource(gateway=_Boom())
        with pytest.raises(QuantError) as exc:
            src.fetch_recent(today=date(2025, 4, 1), quarters=8)
        assert exc.value.code == "SOURCE_UNAVAILABLE"

    def test_partial_period_failure_logs_and_keeps_others(self) -> None:
        class _PartialBoom:
            def __init__(self) -> None:
                self.attempts = 0

            def stock_yjbb_em(self, date: str) -> object:  # noqa: A002
                self.attempts += 1
                if date == "20250331":
                    return [_row("600519", revenue_ytd="100", np_ytd="40", eps="20")]
                raise RuntimeError("fail")

            def stock_individual_info_em(self, symbol: str) -> object:  # noqa: ARG002
                return []

            def stock_financial_abstract_ths(self, symbol: str) -> object:  # noqa: ARG002
                return []

        src = AKShareFinancialsBulkSource(gateway=_PartialBoom())
        out = src.fetch_recent(today=date(2025, 4, 1), quarters=8)
        assert "600519" in out

    def test_invalid_quarters_arg(self) -> None:
        src = AKShareFinancialsBulkSource(gateway=_FakeBulkGateway({}))
        with pytest.raises(QuantError):
            src.fetch_recent(today=date(2025, 4, 1), quarters=0)
        with pytest.raises(QuantError):
            src.fetch_recent(today=date(2025, 4, 1), quarters=99)


# ---- Per-stock enricher --------------------------------------------------


class _FakePerStockGateway:
    def __init__(
        self,
        *,
        info_by_code: dict[str, list[dict[str, object]]] | None = None,
        ths_by_code: dict[str, list[dict[str, object]]] | None = None,
    ) -> None:
        self._info = info_by_code or {}
        self._ths = ths_by_code or {}

    def stock_yjbb_em(self, date: str) -> object:  # noqa: A002, ARG002
        raise AssertionError("not used by per-stock enricher")

    def stock_individual_info_em(self, symbol: str) -> list[dict[str, object]]:
        return list(self._info.get(symbol, []))

    def stock_financial_abstract_ths(self, symbol: str) -> list[dict[str, object]]:
        return list(self._ths.get(symbol, []))


class TestPerStockEnricher:
    def test_full_payload(self) -> None:
        gw = _FakePerStockGateway(
            info_by_code={
                "600519": [
                    {"item": "总股本", "value": "1256197800"},
                    {"item": "流通股", "value": "1256197800"},
                ]
            },
            ths_by_code={
                "600519": [
                    {"报告期": "2025-09-30", "营业成本": "11000000000", "扣非净利润": "51800000000"},
                    {"报告期": "2025-06-30", "营业成本": "10000000000", "扣非净利润": "30000000000"},
                ]
            },
        )
        delta = AKShareFinancialsPerStockEnricher(gateway=gw).fetch_for("600519")
        assert delta is not None
        assert delta.total_share == Decimal("1256197800")
        assert delta.float_share == Decimal("1256197800")
        assert delta.operating_cost_by_period[date(2025, 9, 30)] == Decimal("11000000000")
        assert delta.net_profit_excl_nr_by_period[date(2025, 6, 30)] == Decimal("30000000000")

    def test_invalid_code_returns_none(self) -> None:
        delta = AKShareFinancialsPerStockEnricher(
            gateway=_FakePerStockGateway()
        ).fetch_for("BAD123")
        assert delta is None

    def test_both_endpoints_empty_returns_none(self) -> None:
        delta = AKShareFinancialsPerStockEnricher(
            gateway=_FakePerStockGateway()
        ).fetch_for("600519")
        assert delta is None

    def test_partial_failure_keeps_other_endpoint(self) -> None:
        class _Mixed:
            def stock_yjbb_em(self, date: str) -> object:  # noqa: A002, ARG002
                return []

            def stock_individual_info_em(self, symbol: str) -> object:  # noqa: ARG002
                raise RuntimeError("EM down")

            def stock_financial_abstract_ths(self, symbol: str) -> list[dict[str, object]]:  # noqa: ARG002
                return [
                    {"报告期": "2025-09-30", "营业成本": "100", "扣非净利润": None},
                ]

        delta = AKShareFinancialsPerStockEnricher(gateway=_Mixed()).fetch_for("600519")
        assert delta is not None
        assert delta.total_share is None
        assert delta.operating_cost_by_period[date(2025, 9, 30)] == Decimal("100")
