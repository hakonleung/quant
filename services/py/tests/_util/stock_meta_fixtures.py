"""Shared :class:`StockMeta` sample data for tests."""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

from quant_core.domain.types.stock import StockMeta

UPDATED_AT = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC)


def make_meta(
    code: str,
    *,
    name: str = "",
    industry_sw_l2: str = "白酒",
    status: str = "NORMAL",
) -> StockMeta:
    return StockMeta(
        code=code,
        name=name or f"name-{code}",
        name_pinyin=code[:4].upper(),
        exchange="SH" if code.endswith(".SH") else "SZ",
        board="MAIN",
        industry_sw_l1="食品饮料",
        industry_sw_l2=industry_sw_l2,
        industry_sw_l3="高端白酒",
        list_date=date(2001, 8, 27),
        delist_date=None,
        total_share=Decimal("1256197800"),
        float_share=Decimal("1256197800"),
        status=status,  # type: ignore[arg-type]  # tests pass narrow literals
        updated_at=UPDATED_AT,
    )


SEED = (
    make_meta("600519.SH", name="贵州茅台", industry_sw_l2="白酒"),
    make_meta("000858.SZ", name="五粮液", industry_sw_l2="白酒"),
    make_meta("000333.SZ", name="美的集团", industry_sw_l2="家电"),
    make_meta("600036.SH", name="招商银行", industry_sw_l2="股份制银行"),
)
