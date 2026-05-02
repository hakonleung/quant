"""Cache ports — generic storage interfaces consumed by domain Repos.

Three ports cover the data shapes we actually have (cache-abstraction.md §2):

* :class:`KeyValueStore`   — small opaque blobs by string key, optional TTL.
* :class:`RecordRepo`      — typed row CRUD with a tiny ``QuerySpec`` DSL.
* :class:`TimeSeriesStore` — large columnar slices by ``(entity, time)``.

These ports are part of the **core asset** layer (CLAUDE.md §2.5.1): no IO,
no framework, no logger, no env. Adapters live in ``quant_cache`` (or other
sibling packages) and translate to concrete backends.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, TypeVar, runtime_checkable

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence
    from datetime import date, datetime

    import pyarrow as pa

    from quant_core.domain.types.query import QuerySpec

# Invariant: ``upsert_many`` consumes ``Iterable[T]`` (input position), so T
# cannot be declared covariant. Adapters parameterise on a concrete record type.
T = TypeVar("T")


@runtime_checkable
class KeyValueStore(Protocol):
    """Opaque blob store. Backends: filesystem (v1), Redis (v2)."""

    def get(self, key: str) -> bytes | None:
        """Return the stored value, or ``None`` if absent or expired."""
        ...

    def put(self, key: str, value: bytes, *, ttl_sec: int | None = None) -> None:
        """Write ``value`` under ``key``. ``ttl_sec=None`` means no expiry.

        Implementations must be atomic per key: a concurrent ``get`` either
        sees the previous value or the new one, never a partial write.
        """
        ...

    def delete(self, key: str) -> None:
        """Remove ``key``. Idempotent — silent if missing."""
        ...

    def list_prefix(self, prefix: str) -> Iterable[str]:
        """Yield keys whose name starts with ``prefix`` (lexicographic order)."""
        ...


@runtime_checkable
class RecordRepo(Protocol[T]):
    """Typed-row CRUD over a small-to-medium dataset (e.g. stock metadata)."""

    def get(self, key: str) -> T | None:
        """Return the record with primary key ``key``, or ``None``."""
        ...

    def upsert_many(self, items: Iterable[T]) -> None:
        """Insert-or-replace by primary key."""
        ...

    def delete(self, key: str) -> None:
        """Remove by primary key. Idempotent."""
        ...

    def query(self, spec: QuerySpec) -> Iterable[T]:
        """Filter / order / limit. See ``QuerySpec`` for the algebra."""
        ...


@runtime_checkable
class TimeSeriesStore(Protocol):
    """Append-mostly columnar store keyed by ``(entity_key, time)``.

    Returns and accepts ``pyarrow.Table`` for zero-copy hand-off to
    consumers (Polars, Arrow Flight). The schema is fixed per store
    instance — set when the store is constructed in the composition root.
    """

    def append(self, entity_key: str, table: pa.Table) -> None:
        """Append rows for one entity. Caller guarantees no duplicate keys."""
        ...

    def overwrite(self, entity_key: str, table: pa.Table) -> None:
        """Replace the entire entity history (e.g. after a corporate action)."""
        ...

    def read(
        self,
        entity_keys: Sequence[str],
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table:
        """Read a slice across ``entity_keys`` between ``start`` and ``end``.

        Args:
            entity_keys: One or more entities (e.g. stock codes).
            start: Inclusive lower bound on the time column.
            end: Inclusive upper bound on the time column.
            columns: Subset of columns to return. ``None`` returns all.

        Returns:
            A possibly-empty Arrow table conforming to the store schema.
        """
        ...

    def last_timestamp(self, entity_key: str) -> datetime | None:
        """Return the most recent timestamp for ``entity_key`` or ``None``."""
        ...
