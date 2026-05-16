"""Orchestrates the M3 financials track (modules/01-stock-meta.md §5.3).

Two public entry points map 1:1 to Flight ops:

* :meth:`bulk_refresh` — pulls 8 quarters of bulk 业绩报表 across the
  whole market and merges into every meta row that the source emitted
  rows for. Cheap (≈ 9 RTTs total) and updates ``revenue`` /
  ``net_profit`` / ``net_assets`` (when ``total_share`` is known).
* :meth:`enrich_one` — slow per-stock fill-in that completes
  ``operating_cost`` / ``net_profit_excl_nr`` (TTM 毛利率 prerequisite)
  and refreshes ``total_share`` / ``float_share``.

Storage-unify-rollout: neither method persists. They return the
merged :class:`StockMeta` rows; NestJS's ``LocalStockMetaWriterService``
writes them back. Reads still go through the repo so the diff is
computed against the canonical parquet — NestJS and Python see the
same file because it lives on shared local disk.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import TYPE_CHECKING

from quant_core.domain.types.stock import QuarterlyFinancials, StockMeta

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import date

    from quant_io.sources.akshare_financials import (
        AKShareFinancialsBulkSource,
        AKShareFinancialsPerStockEnricher,
    )

    from quant_core.ports.clock import Clock
    from quant_core.ports.stock_meta_repo import StockMetaRepo


logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class FinancialsBulkReport:
    """Result of one :meth:`FinancialsService.bulk_refresh` run."""

    fetched_codes: int
    """Codes that the bulk source returned at least one quarter for."""
    merged: tuple[StockMeta, ...]
    """Merged meta rows ready to be written by NestJS. Empty when no
    incoming row produced a different :class:`StockMeta` than what the
    repo already had."""


class FinancialsService:
    """Bulk + per-stock financials enrichment, write-through to the repo."""

    __slots__ = ("_bulk", "_clock", "_enricher", "_repo")

    def __init__(
        self,
        *,
        repo: StockMetaRepo,
        clock: Clock,
        bulk: AKShareFinancialsBulkSource,
        enricher: AKShareFinancialsPerStockEnricher,
    ) -> None:
        self._repo = repo
        self._clock = clock
        self._bulk = bulk
        self._enricher = enricher

    # -- bulk -----------------------------------------------------------------

    def bulk_refresh(self) -> FinancialsBulkReport:
        """Pull 8 quarters, merge into every known meta row, return them.

        Pure compute: nothing is persisted here. NestJS receives the
        merged rows over Flight and writes them.
        """
        today = self._clock.now().date()
        payloads = self._bulk.fetch_recent(today=today)
        if not payloads:
            return FinancialsBulkReport(fetched_codes=0, merged=())
        existing_by_code = {m.code: m for m in self._repo.list_all()}
        now = self._clock.now()
        merged: list[StockMeta] = []
        for code, payload in payloads.items():
            existing = existing_by_code.get(code)
            if existing is None:
                # Skip codes not in the meta cache — financials without a
                # meta row would be orphaned. The base sync owns the
                # presence list.
                continue
            updated = _merge_bulk(existing, payload, now=now)
            if updated == existing:
                continue
            merged.append(updated)
        return FinancialsBulkReport(
            fetched_codes=len(payloads),
            merged=tuple(merged),
        )

    # -- per-stock -----------------------------------------------------------

    def enrich_one(self, code: str) -> StockMeta | None:
        """Slow-path fill of ``operating_cost`` / ``net_profit_excl_nr`` /
        share counts for ``code``.

        Returns the merged :class:`StockMeta` for the caller to persist,
        or ``None`` when the row was missing, the source returned nothing,
        or the merge produced an identical row (write would be a no-op).
        """
        existing = self._repo.get(code)
        if existing is None:
            return None
        delta = self._enricher.fetch_for(code)
        if delta is None:
            return None
        merged = _merge_enrichment(existing, delta, now=self._clock.now())
        if merged == existing:
            return None
        return merged

    # -- inspector helpers ---------------------------------------------------

    def find_stale_financials(
        self,
        *,
        max_age_days: int = 7,
    ) -> list[str]:
        """Codes that need a per-stock slow-path enrich pass.

        The per-stock track owns ``total_share`` / ``float_share`` /
        ``operating_cost`` / ``net_profit_excl_nr`` — none of which the
        bulk source can fill. So "stale" here is **field-completeness
        first, watermark second**:

        - ``total_share`` is None → never enriched
        - any of the last 4 quarterlies has ``operating_cost`` None →
          毛利率 cannot be derived
        - ``financials_updated_at`` is None or older than
          ``max_age_days`` → regular refresh

        Without this rule the first bulk run would set
        ``financials_updated_at = now()`` on every row, then the same
        scan's stale-list would come back empty and per-stock enrich
        would never fire on a fresh cache.
        """
        items = self._repo.list_all()
        out: list[str] = []
        cutoff = self._clock.now()
        for m in items:
            if m.total_share is None:
                out.append(m.code)
                continue
            if _missing_operating_cost(m):
                out.append(m.code)
                continue
            if m.financials_updated_at is None:
                out.append(m.code)
                continue
            age = (cutoff - m.financials_updated_at).total_seconds()
            if age > max_age_days * 86_400:
                out.append(m.code)
        return out


# -- pure merge helpers (kept local to the service for now) ------------------


def _merge_bulk(
    existing: StockMeta,
    payload: object,
    *,
    now: object,
) -> StockMeta:
    """Apply the bulk delta onto an existing meta row.

    Existing single-quarter rows that the bulk source re-emitted are
    overwritten with the fresh values; rows the bulk didn't cover are
    preserved (e.g. a stock that just listed and has only Q3 in the
    bulk should still keep its older quarterlies).

    ``net_assets`` is computed as ``net_assets_per_share * total_share``
    only when ``total_share`` is already known (the per-stock enricher
    populates it). Without it, ``net_assets`` stays at whatever value
    was previously cached.
    """
    from datetime import datetime as _dt

    from quant_io.sources.akshare_financials import (
        FinancialsBulkPayload,
    )

    if not isinstance(payload, FinancialsBulkPayload):
        raise TypeError("expected FinancialsBulkPayload")
    if not isinstance(now, _dt):
        raise TypeError("now must be a datetime")

    by_period: dict[date, QuarterlyFinancials] = {q.period: q for q in existing.quarterlies}
    for incoming in payload.quarterlies:
        prev = by_period.get(incoming.period)
        # Preserve operating_cost / net_profit_excl_nr from prior rows
        # — bulk endpoint never emits them and we don't want to wipe
        # the slow-path enricher's contribution on every cron tick.
        merged = QuarterlyFinancials(
            period=incoming.period,
            revenue=incoming.revenue
            if incoming.revenue is not None
            else (prev.revenue if prev else None),
            operating_cost=prev.operating_cost if prev else None,
            net_profit=incoming.net_profit
            if incoming.net_profit is not None
            else (prev.net_profit if prev else None),
            net_profit_excl_nr=prev.net_profit_excl_nr if prev else None,
        )
        by_period[incoming.period] = merged

    quarterlies = tuple(sorted(by_period.values(), key=lambda q: q.period))[-8:]

    net_assets = existing.net_assets
    net_assets_period = existing.net_assets_period
    if (
        payload.net_assets_per_share is not None
        and existing.total_share is not None
        and existing.total_share > 0
    ):
        net_assets = payload.net_assets_per_share * existing.total_share
        net_assets_period = payload.net_assets_period

    from dataclasses import replace

    return replace(
        existing,
        quarterlies=quarterlies,
        net_assets=net_assets,
        net_assets_period=net_assets_period,
        financials_updated_at=now,
    )


def _merge_enrichment(
    existing: StockMeta,
    delta: object,
    *,
    now: object,
) -> StockMeta:
    """Apply per-stock slow-path delta onto an existing meta row."""
    from datetime import datetime as _dt

    from quant_io.sources.akshare_financials import (
        FinancialsEnrichmentDelta,
    )

    if not isinstance(delta, FinancialsEnrichmentDelta):
        raise TypeError("expected FinancialsEnrichmentDelta")
    if not isinstance(now, _dt):
        raise TypeError("now must be a datetime")

    quarterlies = tuple(
        QuarterlyFinancials(
            period=q.period,
            revenue=q.revenue,
            operating_cost=delta.operating_cost_by_period.get(q.period, q.operating_cost),
            net_profit=q.net_profit,
            net_profit_excl_nr=delta.net_profit_excl_nr_by_period.get(
                q.period, q.net_profit_excl_nr
            ),
        )
        for q in existing.quarterlies
    )

    total_share = delta.total_share if delta.total_share is not None else existing.total_share
    float_share = delta.float_share if delta.float_share is not None else existing.float_share
    # Recompute net_assets if we now know total_share but didn't before
    # and the bulk EPS-per-share is still cached on the row's latest
    # quarter — but that would require holding the EPS separately. For
    # v1 we just trust what bulk_refresh wrote and leave net_assets as-is.

    from dataclasses import replace

    return replace(
        existing,
        quarterlies=quarterlies,
        total_share=total_share,
        float_share=float_share,
        # `float_pct` legacy field tracks the new ratio when both are
        # known; otherwise leave it alone.
        float_pct=_recompute_float_pct(total_share, float_share, existing.float_pct),
        financials_updated_at=now,
    )


def _recompute_float_pct(
    total_share: Decimal | None,
    float_share: Decimal | None,
    fallback: Decimal,
) -> Decimal:
    if total_share is None or float_share is None or total_share <= 0:
        return fallback
    ratio = float_share / total_share
    if ratio <= 0:
        return fallback
    if ratio > 1:
        return Decimal(1)
    return ratio


def _format_codes(codes: Sequence[str]) -> str:  # pragma: no cover — debug helper
    return ",".join(codes[:8]) + ("…" if len(codes) > 8 else "")


def _missing_operating_cost(meta: StockMeta) -> bool:
    """Whether the per-stock enricher still owes ``operating_cost`` for
    any of the last 4 quarterlies. We cap at 4 because TTM gross-margin
    only reads the most recent year — older holes don't gate the
    derived metric.
    """
    if not meta.quarterlies:
        return False  # No quarterlies at all → bulk owes them, not per-stock.
    return any(q.operating_cost is None for q in meta.quarterlies[-4:])


__all__ = ["FinancialsBulkReport", "FinancialsService", "_format_codes"]
