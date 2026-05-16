"""Full-sync orchestrator for stock metadata (modules/01-stock-meta.md §5.1).

Workflow:
    1. Pull every record from a :class:`StockMetaSource` (via a
       :class:`SourceChain` for fallback).
    2. Diff against what's already in the local
       :class:`StockMetaRepo` so the result reports added / changed /
       unchanged counts.
    3. Return the new+changed records to the caller. NestJS
       (``LocalStockMetaWriterService``) persists them — Python is
       compute-only on the meta parquet write side (storage-unify-rollout).

Pure orchestration: no IO of its own; sources / repo / clock are ports.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from quant_core.domain.types.source import SourceHealth
    from quant_core.domain.types.stock import StockMeta
    from quant_core.ports.clock import Clock
    from quant_core.ports.stock_meta_repo import StockMetaRepo
    from quant_core.ports.stock_meta_source import StockMetaSource
    from quant_core.services.source_chain import SourceChain


logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class SyncReport:
    """Outcome of one full-sync run."""

    source: str
    """Name of the source the chain settled on."""
    fetched: int
    """Total rows the source returned."""
    added: int
    """Rows new to the local repo."""
    changed: int
    """Rows whose payload differs from what was cached."""
    unchanged: int
    """Rows whose payload matched what was cached."""
    upserts: tuple[StockMeta, ...]
    """Rows the caller should persist (added + changed). Empty when
    every fetched row matched the cache."""


class StockMetaSyncService:
    """Coordinates source → repo full sync."""

    __slots__ = ("_chain", "_clock", "_repo")

    def __init__(
        self,
        chain: SourceChain[StockMetaSource],
        repo: StockMetaRepo,
        clock: Clock,
    ) -> None:
        self._chain = chain
        self._repo = repo
        self._clock = clock

    # -- public ---------------------------------------------------------

    def run_full_sync(self) -> SyncReport:
        """Pull from the chain, diff, return upserts.

        Storage-unify: persistence is the caller's job. The Flight
        handler serialises ``report.upserts`` for NestJS to write.

        Raises:
            QuantError: ``SOURCE_UNAVAILABLE`` if every source failed
                (re-raised from :class:`SourceChainExhausted`).
        """

        def fetch(source: StockMetaSource) -> tuple[str, list[StockMeta]]:
            return source.name, list(source.fetch_all())

        chosen_source, items = self._chain.call(fetch)
        return self._diff(chosen_source, items)

    def healthcheck_sources(self) -> list[SourceHealth]:
        """Forwarded to the chain — every source's current health."""
        return list(self._chain.healthcheck_all())

    def enrich_one(self, code: str) -> StockMeta | None:
        """Pull a single stock's full meta from the chain.

        Returns the fetched record for the caller to persist, or
        ``None`` if every source returned ``None`` for ``code``
        (i.e. unknown / delisted).

        Raises:
            QuantError: ``SOURCE_UNAVAILABLE`` if every source failed.
        """

        def fetch(source: StockMetaSource) -> StockMeta | None:
            return source.fetch_one(code)

        return self._chain.call(fetch)

    # -- helpers --------------------------------------------------------

    def _diff(self, source_name: str, items: list[StockMeta]) -> SyncReport:
        existing: dict[str, StockMeta] = {m.code: m for m in self._repo.list_all()}
        added = 0
        changed = 0
        unchanged = 0
        to_upsert: list[StockMeta] = []
        for item in items:
            prev = existing.get(item.code)
            if prev is None:
                added += 1
                to_upsert.append(item)
            elif prev != item:
                changed += 1
                to_upsert.append(item)
            else:
                unchanged += 1
        report = SyncReport(
            source=source_name,
            fetched=len(items),
            added=added,
            changed=changed,
            unchanged=unchanged,
            upserts=tuple(to_upsert),
        )
        logger.info(
            "stock_meta_sync_done",
            extra={
                "source": report.source,
                "fetched": report.fetched,
                "added": report.added,
                "changed": report.changed,
                "unchanged": report.unchanged,
            },
        )
        return report
