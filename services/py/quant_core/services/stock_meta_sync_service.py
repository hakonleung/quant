"""Full-sync orchestrator for stock metadata (modules/01-stock-meta.md §5.1).

Workflow:
    1. Pull every record from a :class:`StockMetaSource` (via a
       :class:`SourceChain` for fallback).
    2. Diff against what's already in the local
       :class:`StockMetaRepo` so the result reports added / changed /
       unchanged counts.
    3. Upsert the new+changed records in one batch.
    4. Persist a sync-state marker (``last_full_sync``, ``source``,
       ``record_count``) into the :class:`KeyValueStore` so the next run
       can decide whether a refresh is due.

Pure orchestration: no IO of its own; all side-effects route through the
injected ports. The Clock port is injected so tests are deterministic.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from quant_core.domain.types.source import SourceHealth
    from quant_core.domain.types.stock import StockMeta
    from quant_core.ports.cache import KeyValueStore
    from quant_core.ports.clock import Clock
    from quant_core.ports.stock_meta_repo import StockMetaRepo
    from quant_core.ports.stock_meta_source import StockMetaSource
    from quant_core.services.source_chain import SourceChain


logger = logging.getLogger(__name__)

_STATE_KEY: Final[str] = "stock_meta:sync_state"


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


@dataclass(frozen=True, slots=True)
class SyncState:
    """Persisted on disk after each sync — see :data:`_STATE_KEY`."""

    last_full_sync: str
    """ISO8601 UTC timestamp of the most recent successful sync."""
    source: str
    """Which source the last successful sync used."""
    record_count: int


class StockMetaSyncService:
    """Coordinates source → repo full sync."""

    __slots__ = ("_chain", "_clock", "_kv", "_repo")

    def __init__(
        self,
        chain: SourceChain[StockMetaSource],
        repo: StockMetaRepo,
        kv: KeyValueStore,
        clock: Clock,
    ) -> None:
        self._chain = chain
        self._repo = repo
        self._kv = kv
        self._clock = clock

    # -- public ---------------------------------------------------------

    def run_full_sync(self) -> SyncReport:
        """Pull from the chain, diff, upsert, persist state.

        Raises:
            QuantError: ``SOURCE_UNAVAILABLE`` if every source failed
                (re-raised from :class:`SourceChainExhausted`).
        """

        # Materialise to a list so we can diff before writing and release
        # the source connection cleanly.
        def fetch(source: StockMetaSource) -> tuple[str, list[StockMeta]]:
            return source.name, list(source.fetch_all())

        chosen_source, items = self._chain.call(fetch)
        report = self._upsert_diff(chosen_source, items)
        self._write_state(report)
        return report

    def get_state(self) -> SyncState | None:
        """Last persisted state, or ``None`` if no sync has run."""
        raw = self._kv.get(_STATE_KEY)
        if raw is None:
            return None
        try:
            doc = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise QuantError(
                "CACHE_CORRUPTED",
                f"sync state at {_STATE_KEY!r} is not valid JSON",
            ) from exc
        if not isinstance(doc, dict):
            raise QuantError("CACHE_CORRUPTED", "sync state must be an object")
        last = doc.get("last_full_sync")
        source = doc.get("source")
        count = doc.get("record_count")
        if not isinstance(last, str) or not isinstance(source, str) or not isinstance(count, int):
            raise QuantError("CACHE_CORRUPTED", "sync state has bad field types")
        return SyncState(last_full_sync=last, source=source, record_count=count)

    def healthcheck_sources(self) -> list[SourceHealth]:
        """Forwarded to the chain — every source's current health."""
        return list(self._chain.healthcheck_all())

    # -- helpers --------------------------------------------------------

    def _upsert_diff(self, source_name: str, items: list[StockMeta]) -> SyncReport:
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
        if to_upsert:
            self._repo.upsert_many(to_upsert)
        report = SyncReport(
            source=source_name,
            fetched=len(items),
            added=added,
            changed=changed,
            unchanged=unchanged,
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

    def _write_state(self, report: SyncReport) -> None:
        state = SyncState(
            last_full_sync=self._clock.now().isoformat(),
            source=report.source,
            record_count=report.fetched,
        )
        body = json.dumps(
            {
                "last_full_sync": state.last_full_sync,
                "source": state.source,
                "record_count": state.record_count,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        self._kv.put(_STATE_KEY, body)
