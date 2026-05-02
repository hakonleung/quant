"""Pyarrow schema + codec for ``StockMeta`` ↔ row dict (cache adapter).

Decimal share counts are persisted as **strings** so the Parquet file is
trivially portable across backends (Postgres NUMERIC, SQLite TEXT) and
free of float rounding. ``date`` / ``datetime`` use native Arrow types so
filters work without string parsing.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Final, cast

import pyarrow as pa
from quant_core.domain.types.stock import (
    Board,
    Exchange,
    StockMeta,
    StockStatus,
)

from quant_cache.parquet_record_repo import Codec

if TYPE_CHECKING:
    from collections.abc import Mapping


STOCK_META_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("name", pa.string()),
        ("name_pinyin", pa.string()),
        ("exchange", pa.string()),
        ("board", pa.string()),
        ("industry_sw_l1", pa.string()),
        ("industry_sw_l2", pa.string()),
        ("industry_sw_l3", pa.string()),
        ("list_date", pa.date32()),
        ("delist_date", pa.date32()),
        ("total_share", pa.string()),
        ("float_share", pa.string()),
        ("status", pa.string()),
        ("updated_at", pa.timestamp("us", tz="UTC")),
    ]
)
"""Schema of the stock-meta parquet file."""

STOCK_META_KEY_FIELD: Final[str] = "code"


def stock_meta_to_row(item: StockMeta) -> Mapping[str, object]:
    return {
        "code": item.code,
        "name": item.name,
        "name_pinyin": item.name_pinyin,
        "exchange": item.exchange,
        "board": item.board,
        "industry_sw_l1": item.industry_sw_l1,
        "industry_sw_l2": item.industry_sw_l2,
        "industry_sw_l3": item.industry_sw_l3,
        "list_date": item.list_date,
        "delist_date": item.delist_date,
        "total_share": str(item.total_share),
        "float_share": str(item.float_share),
        "status": item.status,
        "updated_at": item.updated_at,
    }


def stock_meta_from_row(row: Mapping[str, object]) -> StockMeta:
    list_date = row["list_date"]
    delist_date = row["delist_date"]
    updated_at = row["updated_at"]
    if not isinstance(list_date, date):
        raise ValueError(f"list_date must be a date, got {type(list_date).__name__}")
    if delist_date is not None and not isinstance(delist_date, date):
        raise ValueError(f"delist_date must be a date or None, got {type(delist_date).__name__}")
    if not isinstance(updated_at, datetime):
        raise ValueError(f"updated_at must be a datetime, got {type(updated_at).__name__}")
    if updated_at.tzinfo is None:
        raise ValueError("updated_at must be timezone-aware")
    return StockMeta(
        code=str(row["code"]),
        name=str(row["name"]),
        name_pinyin=str(row["name_pinyin"]),
        exchange=cast("Exchange", str(row["exchange"])),
        board=cast("Board", str(row["board"])),
        industry_sw_l1=str(row["industry_sw_l1"]),
        industry_sw_l2=str(row["industry_sw_l2"]),
        industry_sw_l3=str(row["industry_sw_l3"]),
        list_date=list_date,
        delist_date=delist_date,
        total_share=Decimal(str(row["total_share"])),
        float_share=Decimal(str(row["float_share"])),
        status=cast("StockStatus", str(row["status"])),
        updated_at=updated_at,
    )


def stock_meta_key(item: StockMeta) -> str:
    return item.code


STOCK_META_CODEC: Final[Codec[StockMeta]] = Codec(
    to_row=stock_meta_to_row,
    from_row=stock_meta_from_row,
    key_of=stock_meta_key,
)
