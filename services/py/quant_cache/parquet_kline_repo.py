"""Parquet-backed :class:`KlineRepo` (modules/02-stock-kline.md §4).

Layout: one parquet file per code under ``<root>/<code>.parquet``.
Per-file ``filelock`` serialises mutating operations; reads are
lock-free (atomic ``os.replace`` writes ensure a reader sees one full
version of the file).

Cross-stock slicing (``get_universe_slice``) goes through DuckDB's
``read_parquet`` so a single SQL plan reads all relevant files in
parallel; for single-code reads we use ``pyarrow.parquet`` directly to
keep the hot path cheap.
"""

from __future__ import annotations

import os
import tempfile
from typing import TYPE_CHECKING, Final

import duckdb
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from filelock import FileLock, Timeout

from quant_cache.errors import CacheBackendUnavailable, CacheCorrupted
from quant_cache.kline_schema import (
    KLINE_SCHEMA,
    daily_bar_from_row,
    daily_bar_to_row,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Sequence
    from datetime import date
    from pathlib import Path

    from quant_core.domain.types.kline import DailyBar


_DEFAULT_LOCK_TIMEOUT: Final[float] = 5.0


class ParquetKlineRepo:
    """One-parquet-per-code implementation of :class:`KlineRepo`."""

    __slots__ = ("_lock_timeout", "_root")

    def __init__(self, root: Path, *, lock_timeout_sec: float = _DEFAULT_LOCK_TIMEOUT) -> None:
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise CacheBackendUnavailable(
                f"failed to create kline root: {root}", {"root": str(root)}
            ) from exc
        self._root = root
        self._lock_timeout = lock_timeout_sec

    # -- KlineRepo ------------------------------------------------------

    def upsert_bars(self, code: str, bars: Iterable[DailyBar]) -> None:
        new_table = _bars_to_table(bars)
        if new_table.num_rows == 0:
            return
        new_dates = new_table.column("trade_date")

        def transform(existing: pa.Table) -> pa.Table:
            if existing.num_rows == 0:
                return _sort_by_trade_date(new_table)
            keep_mask = pc.invert(pc.is_in(existing.column("trade_date"), new_dates))
            kept = existing.filter(keep_mask)
            merged = pa.concat_tables([kept, new_table])
            return _sort_by_trade_date(merged)

        self._mutate(code, transform)

    def overwrite_bars(self, code: str, bars: Iterable[DailyBar]) -> None:
        table = _sort_by_trade_date(_bars_to_table(bars))
        self._write_table(code, table)

    def get_range(
        self,
        code: str,
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table:
        path = self._path_for(code)
        if not path.exists():
            return _empty_view(columns)
        # Always read `trade_date` so the range filter has its key column,
        # then drop it on the return path if the caller didn't ask for it.
        read_cols, drop_trade_date = _augment_with_trade_date(columns)
        table = self._read_table(path, columns=read_cols)
        if table.num_rows == 0:
            return _drop_trade_date(table) if drop_trade_date else table
        date_col = table.column("trade_date")
        mask = pc.and_(
            pc.greater_equal(date_col, pa.scalar(start, type=pa.date32())),
            pc.less_equal(date_col, pa.scalar(end, type=pa.date32())),
        )
        filtered = table.filter(mask)
        return _drop_trade_date(filtered) if drop_trade_date else filtered

    def get_universe_slice(
        self,
        codes: Sequence[str],
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table:
        if not codes:
            return _empty_view(columns)
        existing_paths = [str(self._path_for(c)) for c in codes if self._path_for(c).exists()]
        if not existing_paths:
            return _empty_view(columns)
        col_list = "*" if columns is None else ", ".join(_quote_ident(c) for c in columns)
        # `read_parquet` takes a list literal — pass paths as parameter.
        sql = (
            f"SELECT {col_list} FROM read_parquet($paths, union_by_name = true) "
            "WHERE trade_date BETWEEN $start AND $end"
        )
        try:
            con = duckdb.connect(":memory:")
            try:
                result = con.execute(
                    sql,
                    {"paths": existing_paths, "start": start, "end": end},
                ).to_arrow_table()
            finally:
                con.close()
        except duckdb.Error as exc:
            raise CacheBackendUnavailable(
                "duckdb universe slice failed",
                {"codes_count": len(codes)},
            ) from exc
        return result

    def get_last_bar(self, code: str) -> DailyBar | None:
        path = self._path_for(code)
        if not path.exists():
            return None
        table = self._read_table(path)
        if table.num_rows == 0:
            return None
        idx = pc.sort_indices(table, sort_keys=[("trade_date", "descending")])
        latest = table.take(idx).slice(0, 1)
        return daily_bar_from_row(latest.to_pylist()[0])

    def last_trade_date(self, code: str) -> date | None:
        bar = self.get_last_bar(code)
        return bar.trade_date if bar is not None else None

    # -- internals ------------------------------------------------------

    def _path_for(self, code: str) -> Path:
        return self._root / f"{code}.parquet"

    def _lock(self, path: Path) -> FileLock:
        return FileLock(str(path) + ".lock", timeout=self._lock_timeout)

    def _read_table(self, path: Path, *, columns: Sequence[str] | None = None) -> pa.Table:
        try:
            cols = list(columns) if columns is not None else None
            return pq.read_table(path, columns=cols)
        except (pa.ArrowInvalid, pa.ArrowIOError, OSError) as exc:
            raise CacheCorrupted(f"failed to read parquet: {path}", {"path": str(path)}) from exc

    def _write_table(self, code: str, table: pa.Table) -> None:
        path = self._path_for(code)
        try:
            with self._lock(path):
                _atomic_write(path, table)
        except Timeout as exc:
            raise CacheBackendUnavailable(
                f"timed out acquiring lock for {path}",
                {"path": str(path), "timeout_sec": self._lock_timeout},
            ) from exc

    def _mutate(self, code: str, transform: Callable[[pa.Table], pa.Table]) -> None:
        path = self._path_for(code)
        try:
            with self._lock(path):
                table = self._read_table(path) if path.exists() else KLINE_SCHEMA.empty_table()
                new_table = transform(table)
                _atomic_write(path, new_table)
        except Timeout as exc:
            raise CacheBackendUnavailable(
                f"timed out acquiring lock for {path}",
                {"path": str(path), "timeout_sec": self._lock_timeout},
            ) from exc


def _atomic_write(path: Path, table: pa.Table) -> None:
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent,
            prefix=path.name + ".",
            suffix=".tmp",
            delete=False,
        ) as tmp:
            tmp_path = tmp.name
        pq.write_table(table, tmp_path)
        with open(tmp_path, "rb") as f:
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except (OSError, pa.ArrowException) as exc:
        raise CacheBackendUnavailable(
            f"failed to write parquet: {path}", {"path": str(path)}
        ) from exc


def _bars_to_table(bars: Iterable[DailyBar]) -> pa.Table:
    rows = [daily_bar_to_row(b) for b in bars]
    if not rows:
        return KLINE_SCHEMA.empty_table()
    return pa.Table.from_pylist(list(rows), schema=KLINE_SCHEMA)


def _sort_by_trade_date(table: pa.Table) -> pa.Table:
    if table.num_rows <= 1:
        return table
    indices = pc.sort_indices(table, sort_keys=[("trade_date", "ascending")])
    return table.take(indices)


def _augment_with_trade_date(
    columns: Sequence[str] | None,
) -> tuple[list[str] | None, bool]:
    """Return ``(read_cols, drop_trade_date)``.

    If ``columns`` is ``None`` we read everything (no augmentation needed).
    If ``trade_date`` is already in ``columns`` we read what was asked for.
    Otherwise we add ``trade_date`` so the date filter can run, and signal
    the caller to strip it before returning.
    """
    if columns is None:
        return None, False
    cols = list(columns)
    if "trade_date" in cols:
        return cols, False
    return ["trade_date", *cols], True


def _drop_trade_date(table: pa.Table) -> pa.Table:
    return table.drop(["trade_date"])


def _empty_view(columns: Sequence[str] | None) -> pa.Table:
    if columns is None:
        return KLINE_SCHEMA.empty_table()
    fields = [KLINE_SCHEMA.field(c) for c in columns]
    return pa.schema(fields).empty_table()


_IDENT_ALLOWED: Final[frozenset[str]] = frozenset(KLINE_SCHEMA.names)


def _quote_ident(name: str) -> str:
    """Quote a column identifier safely for the SQL ``SELECT`` list.

    DuckDB doesn't bind identifiers, so we whitelist against the schema
    field set (avoids injection via crafted ``columns``).
    """
    if name not in _IDENT_ALLOWED:
        raise CacheBackendUnavailable(
            f"unknown kline column: {name!r}",
            {"field": name, "allowed": sorted(_IDENT_ALLOWED)},
        )
    return f'"{name}"'
