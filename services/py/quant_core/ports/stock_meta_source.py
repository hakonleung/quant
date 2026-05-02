"""``StockMetaSource`` — upstream data-source port for stock metadata.

A *Source* is an SDK-fronted reader (``tushare``, ``akshare``, future
``CSV importer``); a :class:`StockMetaRepo` is the local cache that the
source feeds. The sync service composes them: pull from a source, write
to a repo. They never reference each other directly.

Sources are **stateless** w.r.t. business logic — they perform IO and
return domain objects. They MAY hold a session / token internally and
expose it through ``healthcheck()`` so the chain can probe before
attempting a fetch.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from collections.abc import Iterable

    from quant_core.domain.types.source import SourceHealth
    from quant_core.domain.types.stock import StockMeta


@runtime_checkable
class StockMetaSource(Protocol):
    """An upstream provider of stock-meta records."""

    @property
    def name(self) -> str:
        """Stable identifier (lowercase, kebab-case allowed)."""
        ...

    @property
    def priority(self) -> int:
        """Lower wins. The :class:`SourceChain` tries sources in this order."""
        ...

    def healthcheck(self) -> SourceHealth:
        """Probe the source. MUST NOT raise — failures are reported
        in :class:`SourceHealth.last_error`.
        """
        ...

    def fetch_all(self) -> Iterable[StockMeta]:
        """Pull every stock currently visible from the source.

        Raises:
            QuantError: with a code in the ``SOURCE_*`` family on
                transport / quota / parse failures (see ``proto/errors.json``).
        """
        ...

    def fetch_one(self, code: str) -> StockMeta | None:
        """Single-row read. Returns ``None`` if the source has no record."""
        ...
