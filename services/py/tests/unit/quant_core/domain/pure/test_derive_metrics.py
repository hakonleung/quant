"""Unit tests for ``derive_metrics``.

Pure-function module → zero mocks, only fixture inputs. Each metric has
its own group of cases: golden path, missing-input → ``None``,
denominator ≤ 0 → ``None``, plus regressions documented in
``docs/modules/01-stock-meta.md``.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from quant_core.domain.pure.derive_metrics import derive_metrics
from quant_core.domain.types.stock import QuarterlyFinancials, StockMeta


def _meta(
    *,
    total_share: Decimal | None = Decimal("1000"),
    float_share: Decimal | None = Decimal("800"),
    net_assets: Decimal | None = Decimal("5000"),
    net_assets_period: date | None = date(2025, 9, 30),
    quarterlies: tuple[QuarterlyFinancials, ...] = (),
) -> StockMeta:
    return StockMeta(
        code="600519",
        name="贵州茅台",
        name_pinyin="GZMT",
        industries="食品饮料,白酒",
        list_date=date(2001, 8, 27),
        float_pct=Decimal("0.8"),
        updated_at=datetime(2026, 5, 1, tzinfo=UTC),
        total_share=total_share,
        float_share=float_share,
        net_assets=net_assets,
        net_assets_period=net_assets_period,
        quarterlies=quarterlies,
        financials_updated_at=datetime(2026, 5, 1, tzinfo=UTC),
    )


def _q(period: date, np: Decimal | None, rev: Decimal | None = None, cost: Decimal | None = None) -> QuarterlyFinancials:
    return QuarterlyFinancials(
        period=period,
        revenue=rev,
        operating_cost=cost,
        net_profit=np,
        net_profit_excl_nr=np,
    )


def _eight_quarters(net_profits: list[Decimal]) -> tuple[QuarterlyFinancials, ...]:
    """Build 8 quarterlies with the given net-profit sequence (oldest → newest).

    Periods walk Q4 of year-2 → Q3 of year-0 (i.e. typical
    "previous-year + current-year through Q3" layout).
    """
    assert len(net_profits) == 8
    periods = [
        date(2023, 12, 31),
        date(2024, 3, 31),
        date(2024, 6, 30),
        date(2024, 9, 30),
        date(2024, 12, 31),
        date(2025, 3, 31),
        date(2025, 6, 30),
        date(2025, 9, 30),
    ]
    return tuple(_q(p, np, rev=Decimal("100"), cost=Decimal("40")) for p, np in zip(periods, net_profits, strict=True))


# -- mkt_cap / float_mkt_cap ----------------------------------------------


class TestMktCap:
    def test_golden(self) -> None:
        d = derive_metrics(_meta(), Decimal("100"))
        assert d.mkt_cap == Decimal("100000")
        assert d.float_mkt_cap == Decimal("80000")

    def test_no_price_returns_all_none(self) -> None:
        d = derive_metrics(_meta(), None)
        assert d.mkt_cap is None
        assert d.float_mkt_cap is None
        assert d.pe_ttm is None
        assert d.pb is None

    def test_zero_price_returns_all_none(self) -> None:
        d = derive_metrics(_meta(), Decimal("0"))
        assert d.mkt_cap is None

    def test_missing_total_share(self) -> None:
        d = derive_metrics(_meta(total_share=None), Decimal("100"))
        assert d.mkt_cap is None

    def test_missing_float_share(self) -> None:
        d = derive_metrics(_meta(float_share=None), Decimal("100"))
        assert d.float_mkt_cap is None
        assert d.mkt_cap == Decimal("100000")  # mkt_cap unaffected


# -- pe_ttm ----------------------------------------------------------------


class TestPeTtm:
    def test_golden(self) -> None:
        meta = _meta(
            quarterlies=_eight_quarters(
                [Decimal(p) for p in [10, 10, 10, 10, 10, 10, 10, 10]]
            )
        )
        d = derive_metrics(meta, Decimal("100"))
        # mkt_cap 100_000 / sum(last 4 net_profit) 40 = 2500
        assert d.pe_ttm == Decimal("2500")

    def test_fewer_than_4_quarters_returns_none(self) -> None:
        qs = (_q(date(2025, 9, 30), Decimal("10")),)
        d = derive_metrics(_meta(quarterlies=qs), Decimal("100"))
        assert d.pe_ttm is None

    def test_any_missing_net_profit_returns_none(self) -> None:
        qs = _eight_quarters([Decimal(p) for p in [10, 10, 10, 10, 10, 10, 10, 0]])
        # last-4 sum = 30, but net_profit can be 0 — that returns 0, not None
        # so we test the explicit None case here:
        bad = list(qs)
        bad[-1] = _q(date(2025, 9, 30), None)
        d = derive_metrics(_meta(quarterlies=tuple(bad)), Decimal("100"))
        assert d.pe_ttm is None

    def test_zero_ttm_profit_returns_none(self) -> None:
        qs = _eight_quarters([Decimal("0")] * 8)
        d = derive_metrics(_meta(quarterlies=qs), Decimal("100"))
        assert d.pe_ttm is None


# -- pe_dynamic (EastMoney style) -----------------------------------------


class TestPeDynamic:
    def test_q3_annualises_by_4_over_3(self) -> None:
        # Q3 latest, net_profit 30 → annualised = 30 * 4 / 3 = 40
        # mkt_cap 100_000 / 40 = 2500
        qs = (_q(date(2025, 9, 30), Decimal("30")),)
        d = derive_metrics(_meta(quarterlies=qs), Decimal("100"))
        assert d.pe_dynamic == Decimal("2500")

    def test_q4_annualises_by_4_over_4(self) -> None:
        qs = (_q(date(2024, 12, 31), Decimal("40")),)
        d = derive_metrics(_meta(quarterlies=qs), Decimal("100"))
        # 40 * 4 / 4 = 40 → 100_000 / 40 = 2500
        assert d.pe_dynamic == Decimal("2500")

    def test_q1_annualises_by_4_over_1(self) -> None:
        qs = (_q(date(2025, 3, 31), Decimal("10")),)
        d = derive_metrics(_meta(quarterlies=qs), Decimal("100"))
        # 10 * 4 / 1 = 40 → 100_000 / 40 = 2500
        assert d.pe_dynamic == Decimal("2500")

    def test_negative_latest_profit_returns_none(self) -> None:
        qs = (_q(date(2025, 9, 30), Decimal("-1")),)
        d = derive_metrics(_meta(quarterlies=qs), Decimal("100"))
        assert d.pe_dynamic is None

    def test_no_quarterlies_returns_none(self) -> None:
        d = derive_metrics(_meta(), Decimal("100"))
        assert d.pe_dynamic is None

    def test_off_quarter_period_returns_none(self) -> None:
        # Period not on a calendar quarter end → `_quarter_index` returns None.
        qs = (_q(date(2025, 7, 31), Decimal("10")),)
        d = derive_metrics(_meta(quarterlies=qs), Decimal("100"))
        assert d.pe_dynamic is None


# -- pb ---------------------------------------------------------------------


class TestPb:
    def test_golden(self) -> None:
        # mkt_cap 100_000 / net_assets 5000 = 20
        d = derive_metrics(_meta(), Decimal("100"))
        assert d.pb == Decimal("20")

    def test_missing_net_assets(self) -> None:
        d = derive_metrics(_meta(net_assets=None), Decimal("100"))
        assert d.pb is None

    def test_zero_net_assets(self) -> None:
        d = derive_metrics(_meta(net_assets=Decimal("0")), Decimal("100"))
        assert d.pb is None


# -- peg --------------------------------------------------------------------


class TestPeg:
    def test_golden(self) -> None:
        # prior 4Q sum = 40, recent 4Q sum = 80 → growth_pct = 100
        # pe_ttm = 100_000 / 80 = 1250 → peg = 1250 / 100 = 12.5
        meta = _meta(
            quarterlies=_eight_quarters(
                [Decimal(p) for p in [10, 10, 10, 10, 20, 20, 20, 20]]
            )
        )
        d = derive_metrics(meta, Decimal("100"))
        assert d.pe_ttm == Decimal("1250")
        assert d.peg == Decimal("12.5")

    def test_fewer_than_8_quarters(self) -> None:
        # Only 4 quarters → pe_ttm OK, but peg requires 8
        qs = tuple(
            _q(date(2025, m, 31 if m in {1, 3, 5, 7, 8, 10, 12} else 30), Decimal("10"))
            for m in [3, 6, 9, 12]
        )
        d = derive_metrics(_meta(quarterlies=qs), Decimal("100"))
        assert d.pe_ttm is not None
        assert d.peg is None

    def test_negative_growth_returns_none(self) -> None:
        meta = _meta(
            quarterlies=_eight_quarters(
                [Decimal(p) for p in [20, 20, 20, 20, 10, 10, 10, 10]]
            )
        )
        d = derive_metrics(meta, Decimal("100"))
        assert d.peg is None

    def test_prior_period_loss_returns_none(self) -> None:
        # If prior TTM is ≤ 0, growth is undefined → None.
        meta = _meta(
            quarterlies=_eight_quarters(
                [Decimal(p) for p in [-5, -5, -5, -5, 10, 10, 10, 10]]
            )
        )
        d = derive_metrics(meta, Decimal("100"))
        assert d.peg is None


# -- gross_margin_ttm -------------------------------------------------------


class TestGrossMargin:
    def test_golden(self) -> None:
        # 4Q rev = 400, cost = 160 → margin = 0.6
        meta = _meta(
            quarterlies=tuple(
                _q(date(2025, m, 31 if m in {3, 12} else 30), Decimal("10"), Decimal("100"), Decimal("40"))
                for m in [3, 6, 9, 12]
            )
        )
        d = derive_metrics(meta, Decimal("100"))
        assert d.gross_margin_ttm == Decimal("0.6")

    def test_fewer_than_4_quarters(self) -> None:
        qs = (_q(date(2025, 9, 30), Decimal("10"), Decimal("100"), Decimal("40")),)
        d = derive_metrics(_meta(quarterlies=qs), Decimal("100"))
        assert d.gross_margin_ttm is None

    def test_missing_revenue_in_any_quarter(self) -> None:
        qs = list(
            _q(date(2025, m, 31 if m in {3, 12} else 30), Decimal("10"), Decimal("100"), Decimal("40"))
            for m in [3, 6, 9, 12]
        )
        qs[-1] = _q(date(2025, 12, 31), Decimal("10"), None, Decimal("40"))
        d = derive_metrics(_meta(quarterlies=tuple(qs)), Decimal("100"))
        assert d.gross_margin_ttm is None

    def test_zero_revenue_returns_none(self) -> None:
        qs = tuple(
            _q(date(2025, m, 31 if m in {3, 12} else 30), Decimal("10"), Decimal("0"), Decimal("0"))
            for m in [3, 6, 9, 12]
        )
        d = derive_metrics(_meta(quarterlies=qs), Decimal("100"))
        assert d.gross_margin_ttm is None


# -- precision regression ---------------------------------------------------


def test_decimal_precision_preserved_on_large_mkt_cap() -> None:
    # Uses a price that would trip a float (50.05 is binary-inexact).
    meta = _meta(total_share=Decimal("8134600000"), float_share=None)
    d = derive_metrics(meta, Decimal("50.05"))
    assert d.mkt_cap == Decimal("407136730000.00")
