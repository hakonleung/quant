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
    industries: str = "白酒",
    float_pct: Decimal = Decimal(1),
) -> StockMeta:
    return StockMeta(
        code=code,
        name=name or f"name-{code}",
        name_pinyin=code[:4].upper(),
        industries=industries,
        list_date=date(2001, 8, 27),
        float_pct=float_pct,
        updated_at=UPDATED_AT,
    )


SEED = (
    make_meta("600519", name="贵州茅台", industries="食品饮料,白酒"),
    make_meta("000858", name="五粮液", industries="食品饮料,白酒"),
    make_meta("000333", name="美的集团", industries="家电"),
    make_meta("600036", name="招商银行", industries="股份制银行"),
)
