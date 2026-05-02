"""Flight ops for stock metadata (modules/01-stock-meta.md §6.3).

Two ops:

* ``get_stock_meta_batch`` — args ``{"codes": ["600519.SH", ...]}``;
  returns one row per resolved code, in the input order.
* ``list_stock_meta_by_industry`` — args ``{"sw_l2": "白酒"}``; returns
  every stock in that Shenwan L2 industry, sorted by ``code``.

Both handlers translate ``args`` to a typed call into
:class:`StockMetaService`; the service owns missing-code semantics. The
output Arrow schema is shared across both ops via
:data:`STOCK_META_SCHEMA`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_cache.stock_meta_schema import STOCK_META_SCHEMA, stock_meta_to_row
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.domain.types.stock import StockMeta
    from quant_core.services.stock_meta_service import StockMetaService


_GET_BATCH_OP: Final[str] = "get_stock_meta_batch"
_LIST_BY_INDUSTRY_OP: Final[str] = "list_stock_meta_by_industry"
_LIST_ALL_OP: Final[str] = "list_stock_meta_all"


def _items_to_table(items: list[StockMeta]) -> pa.Table:
    if not items:
        return STOCK_META_SCHEMA.empty_table()
    rows = [stock_meta_to_row(item) for item in items]
    return pa.Table.from_pylist(rows, schema=STOCK_META_SCHEMA)


def _require_str_list(args: Mapping[str, object], key: str) -> list[str]:
    raw = args.get(key)
    if not isinstance(raw, list):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a list of strings",
            {"got": type(raw).__name__},
        )
    out: list[str] = []
    for i, value in enumerate(raw):
        if not isinstance(value, str):
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.{key}[{i}] must be a string",
                {"index": i, "got": type(value).__name__},
            )
        out.append(value)
    return out


def _require_str(args: Mapping[str, object], key: str) -> str:
    raw = args.get(key)
    if not isinstance(raw, str) or not raw:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a non-empty string",
            {"key": key},
        )
    return raw


class GetStockMetaBatchHandler:
    """``get_stock_meta_batch`` — fetch many stocks by code in one call."""

    op = _GET_BATCH_OP
    schema = STOCK_META_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: StockMetaService) -> None:
        self._service = service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        codes = _require_str_list(args, "codes")
        items = self._service.get_batch(codes)
        return _items_to_table(items)


class ListByIndustryHandler:
    """``list_stock_meta_by_industry`` — fetch a whole Shenwan L2 industry."""

    op = _LIST_BY_INDUSTRY_OP
    schema = STOCK_META_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: StockMetaService) -> None:
        self._service = service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        sw_l2 = _require_str(args, "sw_l2")
        return _items_to_table(self._service.list_by_industry(sw_l2))


class ListAllHandler:
    """``list_stock_meta_all`` — fetch every stock currently in the cache.

    Bounded dataset (~5k rows for A-share); the call is cheap enough that
    we serve it as one Flight stream rather than paginate.
    """

    op = _LIST_ALL_OP
    schema = STOCK_META_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: StockMetaService) -> None:
        self._service = service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        del args  # this op takes none
        return _items_to_table(self._service.list_all())
