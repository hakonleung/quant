"""Pyarrow schema + (de)serialiser for :class:`DailyBar`.

Decimals persisted as fixed-precision ``decimal128`` so the parquet file
round-trips exactly across Pandas / Polars / DuckDB readers. Decimal
columns use the precision/scale defined in ``modules/02-stock-kline.md``
§10.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_core.domain.types.kline import DailyBar

if TYPE_CHECKING:
    from collections.abc import Mapping


# decimal128 precision is total digits; scale is fraction digits.
_PRICE_TYPE: Final[pa.DataType] = pa.decimal128(20, 4)
_AMOUNT_TYPE: Final[pa.DataType] = pa.decimal128(20, 2)
_RATE_TYPE: Final[pa.DataType] = pa.decimal128(12, 6)
_FACTOR_TYPE: Final[pa.DataType] = pa.decimal128(12, 4)


KLINE_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("trade_date", pa.date32()),
        ("open", _PRICE_TYPE),
        ("high", _PRICE_TYPE),
        ("low", _PRICE_TYPE),
        ("close", _PRICE_TYPE),
        ("volume", pa.int64()),
        ("amount", _AMOUNT_TYPE),
        ("turnover_rate", _RATE_TYPE),
        ("open_qfq", _PRICE_TYPE),
        ("high_qfq", _PRICE_TYPE),
        ("low_qfq", _PRICE_TYPE),
        ("close_qfq", _PRICE_TYPE),
        ("ma5", _PRICE_TYPE),
        ("ma10", _PRICE_TYPE),
        ("ma20", _PRICE_TYPE),
        ("ma60", _PRICE_TYPE),
        ("pct_chg_qfq", _RATE_TYPE),
        ("adj_factor", _FACTOR_TYPE),
    ]
)
"""Schema of one row in ``data/kline/daily/<code>.parquet``."""

KLINE_KEY_FIELD: Final[str] = "trade_date"
"""Per-entity key inside one stock's parquet file."""


def daily_bar_to_row(bar: DailyBar) -> Mapping[str, object]:
    return {
        "code": bar.code,
        "trade_date": bar.trade_date,
        "open": bar.open,
        "high": bar.high,
        "low": bar.low,
        "close": bar.close,
        "volume": bar.volume,
        "amount": bar.amount,
        "turnover_rate": bar.turnover_rate,
        "open_qfq": bar.open_qfq,
        "high_qfq": bar.high_qfq,
        "low_qfq": bar.low_qfq,
        "close_qfq": bar.close_qfq,
        "ma5": bar.ma5,
        "ma10": bar.ma10,
        "ma20": bar.ma20,
        "ma60": bar.ma60,
        "pct_chg_qfq": bar.pct_chg_qfq,
        "adj_factor": bar.adj_factor,
    }


def daily_bar_from_row(row: Mapping[str, object]) -> DailyBar:
    trade_date = row["trade_date"]
    if not isinstance(trade_date, date):
        raise ValueError(f"trade_date must be a date, got {type(trade_date).__name__}")
    return DailyBar(
        code=str(row["code"]),
        trade_date=trade_date,
        open=_dec(row["open"]),
        high=_dec(row["high"]),
        low=_dec(row["low"]),
        close=_dec(row["close"]),
        volume=_int(row["volume"]),
        amount=_dec(row["amount"]),
        turnover_rate=_dec(row["turnover_rate"]),
        open_qfq=_dec(row["open_qfq"]),
        high_qfq=_dec(row["high_qfq"]),
        low_qfq=_dec(row["low_qfq"]),
        close_qfq=_dec(row["close_qfq"]),
        ma5=_dec_or_none(row["ma5"]),
        ma10=_dec_or_none(row["ma10"]),
        ma20=_dec_or_none(row["ma20"]),
        ma60=_dec_or_none(row["ma60"]),
        pct_chg_qfq=_dec_or_none(row["pct_chg_qfq"]),
        adj_factor=_dec(row["adj_factor"]),
    )


def _int(v: object) -> int:
    if isinstance(v, int) and not isinstance(v, bool):
        return v
    if isinstance(v, (str, float)):
        return int(v)
    raise ValueError(f"unsupported int source: {type(v).__name__}")


def _dec(v: object) -> Decimal:
    if isinstance(v, Decimal):
        return v
    return Decimal(str(v))


def _dec_or_none(v: object) -> Decimal | None:
    if v is None:
        return None
    return _dec(v)
