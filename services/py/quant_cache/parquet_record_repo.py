"""Parquet-backed :class:`RecordRepo` adapter (cache-abstraction.md §4).

One parquet file per repo instance — all records of type ``T`` live in a
single file. This matches the "small-to-medium dataset" niche the
:class:`RecordRepo` port is designed for (cache-abstraction.md §2.2);
KLine-style large time-series go through ``TimeSeriesStore`` instead.

Concurrency model:
    Per-file ``filelock.FileLock`` serialises mutating operations
    (``upsert_many``, ``delete``) so concurrent writers cannot lose updates.
    Writes are atomic via ``tempfile`` + ``os.replace`` — a concurrent reader
    sees either the previous file or the new one, never a partial parquet.

Codec injection:
    The repo is generic over ``T``. Callers wire a :class:`Codec` describing
    how to map ``T`` ↔ row dict, the parquet ``schema``, and the primary-key
    field name. The repo itself never knows ``T`` concretely.
"""

from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final, Generic, TypeVar

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from filelock import FileLock, Timeout
from quant_core.domain.types.query import And, Eq, In, Like, Or, Predicate, QuerySpec, Range

from quant_cache.errors import CacheBackendUnavailable, CacheCorrupted

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Iterator, Mapping
    from pathlib import Path

T = TypeVar("T")

# Pyarrow stubs do not export `pyarrow.compute.Expression`; alias to Any so
# the per-module override (disallow_any_explicit = false) covers our usage.
_Expr = Any

_DEFAULT_LOCK_TIMEOUT: Final[float] = 5.0


@dataclass(frozen=True, slots=True)
class Codec(Generic[T]):
    """How to (de)serialise a record between ``T`` and a row dict.

    Args:
        to_row: ``T`` → mapping matching ``schema`` (one entry per column).
        from_row: mapping (column name → cell) → ``T``.
        key_of: fast accessor for the primary key of ``T`` (avoids a full
            ``to_row`` call on the upsert hot path).
    """

    to_row: Callable[[T], Mapping[str, object]]
    from_row: Callable[[Mapping[str, object]], T]
    key_of: Callable[[T], str]


class ParquetRecordRepo(Generic[T]):
    """Single-file parquet implementation of :class:`RecordRepo` for ``T``.

    Args:
        path: Parquet file path. Parent directory is created on first write.
        schema: Pyarrow schema describing one row of ``T``.
        key_field: Name of the primary-key column in ``schema``.
        codec: ``T`` ↔ row mapping (see :class:`Codec`).
        lock_timeout_sec: Seconds to wait for the file lock before failing.

    Raises:
        CacheBackendUnavailable: ``key_field`` is missing from ``schema``,
            or the parent directory cannot be created.
    """

    __slots__ = ("_codec", "_key_field", "_lock_timeout", "_path", "_schema")

    def __init__(
        self,
        path: Path,
        *,
        schema: pa.Schema,
        key_field: str,
        codec: Codec[T],
        lock_timeout_sec: float = _DEFAULT_LOCK_TIMEOUT,
    ) -> None:
        if key_field not in schema.names:
            raise CacheBackendUnavailable(
                f"key_field {key_field!r} not in schema",
                {"key_field": key_field, "schema_names": list(schema.names)},
            )
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise CacheBackendUnavailable(
                f"failed to create parent dir for {path}", {"path": str(path)}
            ) from exc
        self._path = path
        self._schema = schema
        self._key_field = key_field
        self._codec = codec
        self._lock_timeout = lock_timeout_sec

    # -- internal helpers ------------------------------------------------

    def _lock(self) -> FileLock:
        return FileLock(str(self._path) + ".lock", timeout=self._lock_timeout)

    def _read_table(self) -> pa.Table:
        if not self._path.exists():
            return self._schema.empty_table()
        try:
            table = pq.read_table(self._path)
        except (pa.ArrowInvalid, pa.ArrowIOError, OSError) as exc:
            raise CacheCorrupted(
                f"failed to read parquet: {self._path}", {"path": str(self._path)}
            ) from exc
        if table.schema != self._schema:
            raise CacheCorrupted(
                f"parquet schema mismatch: {self._path}",
                {"path": str(self._path)},
            )
        return table

    def _write_table(self, table: pa.Table) -> None:
        try:
            with tempfile.NamedTemporaryFile(
                dir=self._path.parent,
                prefix=self._path.name + ".",
                suffix=".tmp",
                delete=False,
            ) as tmp:
                tmp_path = tmp.name
            pq.write_table(table, tmp_path)
            with open(tmp_path, "rb") as f:
                os.fsync(f.fileno())
            os.replace(tmp_path, self._path)
        except (OSError, pa.ArrowException) as exc:
            raise CacheBackendUnavailable(
                f"failed to write parquet: {self._path}", {"path": str(self._path)}
            ) from exc

    def _mutate(self, transform: Callable[[pa.Table], pa.Table]) -> None:
        try:
            with self._lock():
                table = self._read_table()
                new_table = transform(table)
                self._write_table(new_table)
        except Timeout as exc:
            raise CacheBackendUnavailable(
                f"timed out acquiring lock for {self._path}",
                {"path": str(self._path), "timeout_sec": self._lock_timeout},
            ) from exc

    def _rows_to_table(self, rows: list[Mapping[str, object]]) -> pa.Table:
        if not rows:
            return self._schema.empty_table()
        # `pa.Table.from_pylist` silently fills missing keys with null, so we
        # must validate row shape ourselves to surface codec bugs early.
        expected = set(self._schema.names)
        for row in rows:
            if set(row.keys()) != expected:
                raise CacheBackendUnavailable(
                    f"row dict does not match schema for {self._path}",
                    {
                        "path": str(self._path),
                        "expected": sorted(expected),
                        "got": sorted(row.keys()),
                    },
                )
        try:
            return pa.Table.from_pylist(list(rows), schema=self._schema)
        except (pa.ArrowInvalid, pa.ArrowTypeError) as exc:
            raise CacheBackendUnavailable(
                f"row dict does not match schema for {self._path}",
                {"path": str(self._path)},
            ) from exc

    # -- RecordRepo protocol --------------------------------------------

    def get(self, key: str) -> T | None:
        table = self._read_table()
        if table.num_rows == 0:
            return None
        mask = pc.equal(table[self._key_field], pa.scalar(key))
        filtered = table.filter(mask)
        if filtered.num_rows == 0:
            return None
        return self._codec.from_row(filtered.slice(0, 1).to_pylist()[0])

    def upsert_many(self, items: Iterable[T]) -> None:
        new_rows = [self._codec.to_row(item) for item in items]
        if not new_rows:
            return
        new_keys = {row[self._key_field] for row in new_rows}

        def transform(table: pa.Table) -> pa.Table:
            kept_rows: list[Mapping[str, object]] = []
            for row in table.to_pylist():
                if row[self._key_field] not in new_keys:
                    kept_rows.append(row)
            kept_rows.extend(new_rows)
            return self._rows_to_table(kept_rows)

        self._mutate(transform)

    def delete(self, key: str) -> None:
        def transform(table: pa.Table) -> pa.Table:
            if table.num_rows == 0:
                return table
            mask = pc.not_equal(table[self._key_field], pa.scalar(key))
            return table.filter(mask)

        self._mutate(transform)

    def query(self, spec: QuerySpec) -> Iterator[T]:
        table = self._read_table()
        if spec.where is not None and table.num_rows > 0:
            table = table.filter(_predicate_to_expr(spec.where, self._schema))
        if spec.order_by:
            # QuerySpec uses short SQL-like "asc"/"desc"; pyarrow wants the
            # full word.
            sort_keys = [
                (field, "ascending" if direction == "asc" else "descending")
                for field, direction in spec.order_by
            ]
            try:
                indices = pc.sort_indices(table, sort_keys=sort_keys)
            except (pa.ArrowInvalid, pa.ArrowKeyError) as exc:
                raise CacheBackendUnavailable(
                    f"unknown order_by column for {self._path}",
                    {"order_by": list(spec.order_by)},
                ) from exc
            table = table.take(indices)
        if spec.limit is not None:
            table = table.slice(0, spec.limit)
        for row in table.to_pylist():
            yield self._codec.from_row(row)


# -- QuerySpec → pyarrow expression --------------------------------------


def _like_to_regex(pattern: str) -> str:
    """Translate SQL LIKE wildcards to a Python regex anchored on both ends."""
    out: list[str] = ["^"]
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "%":
            out.append(".*")
        elif ch == "_":
            out.append(".")
        else:
            out.append(re.escape(ch))
        i += 1
    out.append("$")
    return "".join(out)


def _eq_expr(node: Eq, schema: pa.Schema) -> _Expr:
    _ensure_field(node.field, schema)
    if node.value is None:
        return pc.field(node.field).is_null()
    return pc.field(node.field) == node.value


def _in_expr(node: In, schema: pa.Schema) -> _Expr:
    _ensure_field(node.field, schema)
    if not node.values:
        return pc.scalar(False)
    return pc.is_in(pc.field(node.field), pa.array(list(node.values)))


def _range_expr(node: Range, schema: pa.Schema) -> _Expr:
    _ensure_field(node.field, schema)
    col = pc.field(node.field)
    parts: list[_Expr] = []
    if node.lo is not None:
        parts.append(col >= node.lo)
    if node.hi is not None:
        parts.append(col <= node.hi)
    if not parts:
        return pc.scalar(True)
    return _and_all(parts)


def _like_expr(node: Like, schema: pa.Schema) -> _Expr:
    _ensure_field(node.field, schema)
    return pc.match_substring_regex(pc.field(node.field), _like_to_regex(node.pattern))


def _and_expr(node: And, schema: pa.Schema) -> _Expr:
    if not node.parts:
        return pc.scalar(True)
    return _and_all([_predicate_to_expr(p, schema) for p in node.parts])


def _or_expr(node: Or, schema: pa.Schema) -> _Expr:
    if not node.parts:
        return pc.scalar(False)
    return _or_all([_predicate_to_expr(p, schema) for p in node.parts])


def _predicate_to_expr(pred: Predicate, schema: pa.Schema) -> _Expr:
    """Translate a :class:`Predicate` node to a pyarrow compute expression.

    Raises:
        CacheBackendUnavailable: predicate references a column absent from
            ``schema``.
    """
    if isinstance(pred, Eq):
        return _eq_expr(pred, schema)
    if isinstance(pred, In):
        return _in_expr(pred, schema)
    if isinstance(pred, Range):
        return _range_expr(pred, schema)
    if isinstance(pred, Like):
        return _like_expr(pred, schema)
    if isinstance(pred, And):
        return _and_expr(pred, schema)
    if isinstance(pred, Or):
        return _or_expr(pred, schema)
    raise AssertionError(f"unreachable Predicate node: {type(pred).__name__}")


def _ensure_field(name: str, schema: pa.Schema) -> None:
    if name not in schema.names:
        raise CacheBackendUnavailable(
            f"unknown field in QuerySpec: {name!r}",
            {"field": name, "schema_names": list(schema.names)},
        )


def _and_all(parts: list[_Expr]) -> _Expr:
    expr = parts[0]
    for p in parts[1:]:
        expr = expr & p
    return expr


def _or_all(parts: list[_Expr]) -> _Expr:
    expr = parts[0]
    for p in parts[1:]:
        expr = expr | p
    return expr
