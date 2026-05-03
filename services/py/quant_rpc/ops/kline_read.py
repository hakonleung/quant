"""Flight read ops for K-line bars (modules/02-stock-kline.md §6.4 / §10).

* ``list_kline_for_code`` — args ``{"code": "600519", "n": 90}``;
  returns the last *n* daily bars for ``code`` straight from
  :class:`KlineService.get_last_n`. The Arrow schema is the persisted
  parquet schema (``KLINE_SCHEMA``) with one extra ``code`` column for
  forward compatibility (cross-code joins on the gateway).

NestJS uses this op to power ``GET /api/kline/:code?range=…``. The
mapping from human range (``30D`` / ``90D`` / ``250D``) to the integer
``n`` is owned by the gateway — Python only sees the `n` count so it
stays decoupled from front-end ranging conventions.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import pyarrow as pa

from quant_cache.kline_schema import KLINE_SCHEMA
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.services.kline_service import KlineService


_LIST_OP: Final[str] = "list_kline_for_code"
_BULK_OP: Final[str] = "list_kline_bulk_last_n"
_MAX_N: Final[int] = 1000
_MAX_BULK_CODES: Final[int] = 6000


def _require_str(args: "Mapping[str, object]", key: str) -> str:
    raw = args.get(key)
    if not isinstance(raw, str) or not raw:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a non-empty string",
            {"key": key},
        )
    return raw


def _require_positive_int(args: "Mapping[str, object]", key: str, *, default: int) -> int:
    raw = args.get(key)
    if raw is None:
        return default
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be an int",
            {"key": key, "got": type(raw).__name__},
        )
    if raw <= 0 or raw > _MAX_N:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be in (0, {_MAX_N}]",
            {"key": key, "value": raw},
        )
    return raw


def _require_code_list(args: "Mapping[str, object]") -> list[str]:
    raw = args.get("codes")
    if not isinstance(raw, list) or len(raw) == 0:
        raise QuantError(
            "INVALID_ARGUMENT",
            "args.codes must be a non-empty list of strings",
        )
    if len(raw) > _MAX_BULK_CODES:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.codes too large: {len(raw)} > {_MAX_BULK_CODES}",
            {"limit": _MAX_BULK_CODES},
        )
    out: list[str] = []
    for i, item in enumerate(raw):
        if not isinstance(item, str) or not item:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.codes[{i}] must be a non-empty string",
                {"index": i},
            )
        out.append(item)
    return out


class ListKlineForCodeHandler:
    """``list_kline_for_code`` — last *n* persisted bars for a single code."""

    op = _LIST_OP
    schema = KLINE_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: "KlineService") -> None:
        self._service = service

    def execute(self, args: "Mapping[str, object]") -> pa.Table:
        code = _require_str(args, "code")
        n = _require_positive_int(args, "n", default=90)
        table = self._service.get_last_n(code, n)
        # `get_last_n` returns the parquet table verbatim; the schema is
        # already KLINE_SCHEMA, no remapping needed.
        return table


class ListKlineBulkLastNHandler:
    """``list_kline_bulk_last_n`` — last *n* bars for many codes in one call.

    The list-panel needs the latest few bars for every visible row at
    once; spinning N parallel ``list_kline_for_code`` requests over HTTP
    saturated the browser socket pool (ERR_INSUFFICIENT_RESOURCES).
    This op is the bulk variant: the table carries every row tagged
    with its ``code`` so the gateway can group by code in one pass.
    """

    op = _BULK_OP
    schema = KLINE_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: "KlineService") -> None:
        self._service = service

    def execute(self, args: "Mapping[str, object]") -> pa.Table:
        codes = _require_code_list(args)
        n = _require_positive_int(args, "n", default=5)
        tables: list[pa.Table] = []
        for code in codes:
            try:
                slice_ = self._service.get_last_n(code, n)
            except QuantError:
                # Missing parquet / unknown code → skip; the list-panel
                # treats absent rows as "stats not yet available".
                continue
            if slice_.num_rows > 0:
                tables.append(slice_)
        if not tables:
            return KLINE_SCHEMA.empty_table()
        return pa.concat_tables(tables, promote_options="default")
