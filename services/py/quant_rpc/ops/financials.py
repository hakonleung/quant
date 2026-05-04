"""Flight ops for the financials track (modules/01-stock-meta.md §5.3).

Three ops complement the existing meta ops:

* ``bulk_sync_financials`` — runs :meth:`FinancialsService.bulk_refresh`
  and reports `(fetched_codes, updated_codes)`. Cron + manual scan
  invokes this once per scan; no args.
* ``enrich_financials_for_code`` — single-code slow path counterpart
  to ``enrich_stock_meta_for_code``; args ``{"code": "600519"}``.
* ``find_stale_financials`` — read-only, returns the codes the
  inspector should hand to the per-stock queue. Args:
  ``{"max_age_days": 7}``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import pyarrow as pa
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.services.financials_service import FinancialsService


_BULK_OP: Final[str] = "bulk_sync_financials"
_ENRICH_OP: Final[str] = "enrich_financials_for_code"
_STALE_OP: Final[str] = "find_stale_financials"


BULK_FINANCIALS_REPORT_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("fetched_codes", pa.int64()),
        ("updated_codes", pa.int64()),
    ]
)

ENRICH_FINANCIALS_REPORT_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
        ("updated", pa.bool_()),
    ]
)

STALE_FINANCIALS_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        ("code", pa.string()),
    ]
)


class BulkSyncFinancialsHandler:
    """``bulk_sync_financials`` — pull 8 quarters of bulk financials."""

    op = _BULK_OP
    schema = BULK_FINANCIALS_REPORT_SCHEMA

    __slots__ = ("_service",)

    def __init__(self, service: FinancialsService) -> None:
        self._service = service

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        del args
        report = self._service.bulk_refresh()
        return pa.Table.from_pylist(
            [
                {
                    "fetched_codes": report.fetched_codes,
                    "updated_codes": report.updated_codes,
                }
            ],
            schema=BULK_FINANCIALS_REPORT_SCHEMA,
        )


class EnrichFinancialsForCodeHandler:
    """``enrich_financials_for_code`` — per-stock slow path."""

    op = _ENRICH_OP
    schema = ENRICH_FINANCIALS_REPORT_SCHEMA

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
        updated = self._service.enrich_one(raw_code)
        return pa.Table.from_pylist(
            [{"code": raw_code, "updated": updated}],
            schema=ENRICH_FINANCIALS_REPORT_SCHEMA,
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
