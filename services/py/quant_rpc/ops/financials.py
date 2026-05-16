"""Flight ops for the financials track (modules/01-stock-meta.md §5.3).

Three ops complement the existing meta ops:

* ``bulk_sync_financials`` — runs :meth:`FinancialsService.bulk_refresh`
  and returns the merged meta rows in :data:`STOCK_META_SCHEMA` with the
  ``(fetched_codes, updated_codes)`` report encoded in schema metadata.
  No persistence — NestJS's ``LocalStockMetaWriterService`` writes the
  rows.
* ``enrich_financials_for_code`` — single-code slow path counterpart;
  args ``{"code": "600519"}``. Returns 0 or 1 row in
  :data:`STOCK_META_SCHEMA`.
* ``find_stale_financials`` — read-only, returns the codes the
  inspector should hand to the per-stock queue. Args:
  ``{"max_age_days": 7}``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_cache.stock_meta_schema import STOCK_META_SCHEMA, stock_meta_to_row
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.services.financials_service import FinancialsService


_BULK_OP: Final[str] = "bulk_sync_financials"
_ENRICH_OP: Final[str] = "enrich_financials_for_code"
_STALE_OP: Final[str] = "find_stale_financials"


STALE_FINANCIALS_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
    ]
)


class BulkSyncFinancialsHandler:
    """``bulk_sync_financials`` — pull 8 quarters of bulk financials."""

    op = _BULK_OP
    schema = STOCK_META_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: FinancialsService) -> None:
        self._service = service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        del args
        report = self._service.bulk_refresh()
        metadata = {
            b"fetched_codes": str(report.fetched_codes).encode("ascii"),
            b"updated_codes": str(len(report.merged)).encode("ascii"),
        }
        schema = STOCK_META_SCHEMA.with_metadata(metadata)
        if not report.merged:
            return schema.empty_table()
        return pa.Table.from_pylist(
            [stock_meta_to_row(item) for item in report.merged],
            schema=schema,
        )


class EnrichFinancialsForCodeHandler:
    """``enrich_financials_for_code`` — per-stock slow path. 0 or 1 row."""

    op = _ENRICH_OP
    schema = STOCK_META_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: FinancialsService) -> None:
        self._service = service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        raw_code = args.get("code")
        if not isinstance(raw_code, str) or not raw_code:
            raise QuantError(
                "INVALID_ARGUMENT",
                "args.code must be a non-empty string",
                {"key": "code"},
            )
        merged = self._service.enrich_one(raw_code)
        if merged is None:
            return STOCK_META_SCHEMA.empty_table()
        return pa.Table.from_pylist(
            [stock_meta_to_row(merged)],
            schema=STOCK_META_SCHEMA,
        )


class FindStaleFinancialsHandler:
    """``find_stale_financials`` — codes due for per-stock enrich."""

    op = _STALE_OP
    schema = STALE_FINANCIALS_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: FinancialsService) -> None:
        self._service = service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        max_age = args.get("max_age_days", 7)
        if isinstance(max_age, bool) or not isinstance(max_age, int) or max_age <= 0:
            raise QuantError(
                "INVALID_ARGUMENT",
                "args.max_age_days must be a positive int",
                {"value": str(max_age)},
            )
        codes = self._service.find_stale_financials(max_age_days=max_age)
        if not codes:
            return STALE_FINANCIALS_SCHEMA.empty_table()
        return pa.Table.from_pylist(
            [{"code": c} for c in codes],
            schema=STALE_FINANCIALS_SCHEMA,
        )
