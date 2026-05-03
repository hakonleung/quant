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
_MAX_N: Final[int] = 1000


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
