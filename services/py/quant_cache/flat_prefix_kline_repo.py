"""Flat-prefix Parquet :class:`KlineRepo` (modules/02-stock-kline.md §4).

Reads from the **NestJS-canonical** kline layout at
``<root>/<prefix>.parquet`` (13 partitions for A-shares, one row per
``(code, trade_date)``, float64 throughout — see
``apps/api/src/modules/kline/kline.row.ts``).

This repo is read-only: NestJS's ``KlineWriterService`` owns every
write since the Phase 2 flip. The legacy per-code Decimal128 cache at
``data/kline.py/`` is gone.

Layer adaptation:

* The parquet uses ``ts`` (date32) — we alias to ``trade_date`` so the
  business code keeps querying the column name they already had.
* The parquet uses ``float64`` for prices / rates / amount. We cast to
  the original ``decimal128`` scales at the boundary so callers that
  did decimal math (screen, pattern, blacklist) keep getting exact
  precision. The cast is lossless for our magnitudes (price < 10^4,
  rate < 1, amount < 10^14).
* The parquet does **not** carry raw OHLC / ``adj_factor`` /
  ``pct_chg_qfq``. Screen DSL has been trimmed accordingly; the only
  remaining caller of :meth:`get_last_bar` is ``KlineService.sync_code``
  which now only reads ``trade_date``.
"""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Final

import duckdb
import pyarrow as pa

from quant_cache.errors import CacheBackendUnavailable
from quant_cache.kline_schema import KLINE_SCHEMA

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence
    from datetime import date
    from pathlib import Path

    from quant_core.domain.types.kline import DailyBar


# Columns that exist in the NestJS-canonical layout. Anything the caller
# asks for that isn't in this set has to be synthesised or rejected.
_CANONICAL_COLUMNS: Final[frozenset[str]] = frozenset(
    {
        "code",
        "ts",
        "open_qfq",
        "high_qfq",
        "low_qfq",
        "close_qfq",
        "volume",
        "amount",
        "turnover_rate",
        "ma5",
        "ma10",
        "ma20",
        "ma60",
    }
)


# When a caller asks for one of these names we project the canonical
# ``ts`` column and rename it on the way out.
_ALIASES: Final[dict[str, str]] = {"trade_date": "ts"}


# Columns that don't exist on disk but are computed at read time via
# a window function over the partition. The expression is inserted into
# the SELECT list verbatim — the caller must guarantee the column is
# either projected once or aliased on every appearance.
_SYNTHESISED: Final[dict[str, str]] = {
    "pct_chg_qfq": (
        "(close_qfq - LAG(close_qfq) OVER (PARTITION BY code ORDER BY ts)) "
        "/ NULLIF(LAG(close_qfq) OVER (PARTITION BY code ORDER BY ts), 0)"
        " AS pct_chg_qfq"
    ),
}


class FlatPrefixKlineRepo:
    """Read-only repo over ``<root>/<prefix>.parquet`` (float64 layout)."""

    __slots__ = ("_con", "_root")

    def __init__(self, root: Path) -> None:
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise CacheBackendUnavailable(
                f"failed to create kline root: {root}", {"root": str(root)}
            ) from exc
        self._root = root
        # One persistent in-memory DuckDB connection per repo instance —
        # the planner reuses parquet metadata across queries when the
        # connection stays alive (matters for the per-tick watch MA-ref
        # reads: one query x 5000 codes). DuckDBPyConnection itself is
        # NOT thread-safe (concurrent execute/fetch segfaults pyarrow),
        # so every call path below takes `self._con.cursor()` — a cursor
        # shares the parent's catalog + parquet metadata cache but
        # executes independently, which is the supported way to talk to
        # one DuckDB instance from multiple Flight gRPC worker threads.
        self._con = duckdb.connect(":memory:")

    # -- KlineRepo (read paths) -----------------------------------------

    def upsert_bars(self, code: str, bars: Iterable[DailyBar]) -> None:
        # Writes belong to NestJS. The Protocol still has the method so
        # KlineService.sync_code can declare it; calling it is a bug.
        raise CacheBackendUnavailable(
            "FlatPrefixKlineRepo is read-only; writes belong to NestJS "
            "KlineWriterService (storage-unify rollout)",
            {"code": code, "bars_provided": True},
        )

    def overwrite_bars(self, code: str, bars: Iterable[DailyBar]) -> None:
        raise CacheBackendUnavailable(
            "FlatPrefixKlineRepo is read-only; writes belong to NestJS "
            "KlineWriterService (storage-unify rollout)",
            {"code": code, "bars_provided": True},
        )

    def get_range(
        self,
        code: str,
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table:
        path = self._path_for_prefix(code[:3])
        if not path.exists():
            return _empty_view(columns)
        select_list, output_names = _build_select(columns)
        sql = (
            f"SELECT {select_list} FROM read_parquet($path) "
            "WHERE code = $code AND ts BETWEEN $start AND $end "
            "ORDER BY ts"
        )
        try:
            cur = self._con.cursor()
            cur.execute(
                sql,
                {"path": str(path), "code": code, "start": start, "end": end},
            )
            result = cur.to_arrow_table()
        except duckdb.Error as exc:
            raise CacheBackendUnavailable("duckdb get_range failed", {"code": code}) from exc
        return _cast_to_schema(result, output_names)

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
        # Group codes by prefix so we only read the partition files that
        # actually contain any of the requested codes.
        prefixes: dict[str, list[str]] = {}
        for code in codes:
            prefixes.setdefault(code[:3], []).append(code)
        paths: list[str] = []
        for prefix in prefixes:
            path = self._path_for_prefix(prefix)
            if path.exists():
                paths.append(str(path))
        if not paths:
            return _empty_view(columns)
        select_list, output_names = _build_select(columns)
        sql = (
            f"SELECT {select_list} FROM read_parquet($paths) "
            "WHERE code IN (SELECT unnest($codes)) "
            "AND ts BETWEEN $start AND $end "
            "ORDER BY code, ts"
        )
        try:
            cur = self._con.cursor()
            cur.execute(
                sql,
                {
                    "paths": paths,
                    "codes": list(codes),
                    "start": start,
                    "end": end,
                },
            )
            result = cur.to_arrow_table()
        except duckdb.Error as exc:
            raise CacheBackendUnavailable(
                "duckdb universe_slice failed", {"codes_count": len(codes)}
            ) from exc
        return _cast_to_schema(result, output_names)

    def get_last_bar(self, code: str) -> DailyBar | None:
        """Most recent bar for ``code``.

        Synthesises a full :class:`DailyBar` because the canonical layout
        no longer stores raw OHLC / ``adj_factor`` / ``pct_chg_qfq``.
        Raw OHLC mirrors the qfq prices and ``adj_factor`` defaults to
        ``Decimal(1)`` — sound for the only remaining caller
        (``KlineService.sync_code``, which only reads ``trade_date``).
        """
        path = self._path_for_prefix(code[:3])
        if not path.exists():
            return None
        sql = (
            "SELECT ts, open_qfq, high_qfq, low_qfq, close_qfq, "
            "volume, amount, turnover_rate, ma5, ma10, ma20, ma60 "
            "FROM read_parquet($path) "
            "WHERE code = $code ORDER BY ts DESC LIMIT 1"
        )
        try:
            rows = self._con.cursor().execute(sql, {"path": str(path), "code": code}).fetchall()
        except duckdb.Error as exc:
            raise CacheBackendUnavailable("duckdb get_last_bar failed", {"code": code}) from exc
        if not rows:
            return None
        return _row_to_daily_bar(code, rows[0])

    def last_trade_date(self, code: str) -> date | None:
        path = self._path_for_prefix(code[:3])
        if not path.exists():
            return None
        sql = "SELECT max(ts) FROM read_parquet($path) WHERE code = $code"
        try:
            rows = self._con.cursor().execute(sql, {"path": str(path), "code": code}).fetchall()
        except duckdb.Error as exc:
            raise CacheBackendUnavailable("duckdb last_trade_date failed", {"code": code}) from exc
        if not rows or rows[0][0] is None:
            return None
        return _as_date(rows[0][0])

    # -- internals ------------------------------------------------------

    def _path_for_prefix(self, prefix: str) -> Path:
        return self._root / f"{prefix}.parquet"


# Late import to avoid circular import at module load.
def _date_type() -> type:
    from datetime import date

    return date


def _build_select(
    columns: Sequence[str] | None,
) -> tuple[str, list[str]]:
    """Translate caller-facing column names to DuckDB SELECT projections.

    Returns ``(select_list, output_column_names)``. ``output_column_names``
    is what callers see (e.g. ``trade_date`` rather than the on-disk
    ``ts``); ``_cast_to_schema`` then promotes float64 → decimal128 on
    those columns to match :data:`KLINE_SCHEMA`.

    When ``columns`` is ``None`` we project every canonical column with
    ``ts`` aliased back to ``trade_date`` for backwards compatibility.
    """
    if columns is None:
        cols = ["code", "ts AS trade_date"] + [
            c for c in _CANONICAL_COLUMNS if c not in ("code", "ts")
        ]
        out = ["code", "trade_date"] + [c for c in _CANONICAL_COLUMNS if c not in ("code", "ts")]
        return ", ".join(cols), out
    out_names: list[str] = []
    select_parts: list[str] = []
    for name in columns:
        if name in _SYNTHESISED:
            select_parts.append(_SYNTHESISED[name])
            out_names.append(name)
            continue
        on_disk = _ALIASES.get(name, name)
        if on_disk not in _CANONICAL_COLUMNS:
            raise CacheBackendUnavailable(
                f"unknown kline column: {name!r}",
                {
                    "field": name,
                    "allowed": sorted(_CANONICAL_COLUMNS | _ALIASES.keys() | _SYNTHESISED.keys()),
                },
            )
        if name == on_disk:
            select_parts.append(f'"{on_disk}"')
        else:
            select_parts.append(f'"{on_disk}" AS "{name}"')
        out_names.append(name)
    return ", ".join(select_parts), out_names


# decimal scales mirror ``quant_cache.kline_schema``; keep in sync there
# so every column round-trips into ``KLINE_SCHEMA`` cleanly.
_PRICE_TYPE = pa.decimal128(20, 4)
_AMOUNT_TYPE = pa.decimal128(20, 2)
_RATE_TYPE = pa.decimal128(12, 6)

_COLUMN_TYPES: Final[dict[str, pa.DataType]] = {
    "open_qfq": _PRICE_TYPE,
    "high_qfq": _PRICE_TYPE,
    "low_qfq": _PRICE_TYPE,
    "close_qfq": _PRICE_TYPE,
    "amount": _AMOUNT_TYPE,
    "turnover_rate": _RATE_TYPE,
    "ma5": _PRICE_TYPE,
    "ma10": _PRICE_TYPE,
    "ma20": _PRICE_TYPE,
    "ma60": _PRICE_TYPE,
    "pct_chg_qfq": _RATE_TYPE,
}


def _cast_to_schema(table: pa.Table, output_names: list[str]) -> pa.Table:
    """Promote float64 columns to fixed-precision decimals.

    Stops at the row schema: the table's ``trade_date`` column may
    arrive as ``date32`` already (DuckDB's native shape) which matches
    ``KLINE_SCHEMA`` directly. Volume stays int64.
    """
    if table.num_rows == 0:
        return _empty_view(output_names)
    new_columns = []
    new_fields = []
    for name in output_names:
        try:
            col = table.column(name)
        except KeyError:
            continue
        target_type = _COLUMN_TYPES.get(name)
        if target_type is not None and pa.types.is_floating(col.type):
            col = col.cast(target_type, safe=False)
        new_columns.append(col)
        new_fields.append(pa.field(name, col.type))
    return pa.table(new_columns, schema=pa.schema(new_fields))


def _empty_view(columns: Sequence[str] | None) -> pa.Table:
    if columns is None:
        return KLINE_SCHEMA.empty_table()
    fields = []
    for c in columns:
        if c in KLINE_SCHEMA.names:
            fields.append(KLINE_SCHEMA.field(c))
        else:
            # Best-effort fallback — string column.
            fields.append(pa.field(c, pa.string()))
    return pa.schema(fields).empty_table()


def _row_to_daily_bar(code: str, row: tuple[object, ...]) -> DailyBar:
    """Build a :class:`DailyBar` from one (ts, qfq…, ma…) tuple.

    Missing storage fields are synthesised:

    * Raw OHLC ← qfq OHLC (no factor in the new layout means raw == qfq
      from the caller's perspective).
    * ``adj_factor = Decimal(1)`` — placeholder; the only remaining
      caller of ``get_last_bar`` (``KlineService.sync_code``) reads
      only ``trade_date``.
    * ``pct_chg_qfq = None`` — the screen DSL no longer references it.
    """
    from quant_core.domain.types.kline import DailyBar

    (
        trade_date,
        open_qfq,
        high_qfq,
        low_qfq,
        close_qfq,
        volume,
        amount,
        turnover_rate,
        ma5,
        ma10,
        ma20,
        ma60,
    ) = row
    return DailyBar(
        code=code,
        trade_date=_as_date(trade_date),
        open=_dec(open_qfq),
        high=_dec(high_qfq),
        low=_dec(low_qfq),
        close=_dec(close_qfq),
        volume=_as_int(volume),
        amount=_dec(amount),
        turnover_rate=_dec(turnover_rate),
        open_qfq=_dec(open_qfq),
        high_qfq=_dec(high_qfq),
        low_qfq=_dec(low_qfq),
        close_qfq=_dec(close_qfq),
        ma5=_dec_or_none(ma5),
        ma10=_dec_or_none(ma10),
        ma20=_dec_or_none(ma20),
        ma60=_dec_or_none(ma60),
        pct_chg_qfq=None,
        adj_factor=Decimal(1),
    )


def _dec(v: object) -> Decimal:
    if isinstance(v, Decimal):
        return v
    return Decimal(str(v))


def _dec_or_none(v: object) -> Decimal | None:
    return None if v is None else _dec(v)


def _as_int(v: object) -> int:
    if isinstance(v, int) and not isinstance(v, bool):
        return v
    if isinstance(v, (str, float)):
        return int(v)
    raise TypeError(f"cannot coerce {type(v).__name__} to int")


def _as_date(v: object) -> date:
    # DuckDB returns either ``datetime.date`` (connection-level fetch) or
    # ``datetime.datetime`` (cursor-level fetch) for the same date32 column,
    # depending on which API the caller used. Since ``datetime`` subclasses
    # ``date``, a naive isinstance check leaks ``datetime`` instances out
    # and the next downstream comparison (``date > datetime``) raises
    # ``TypeError``. Normalize to ``date`` here.
    from datetime import date, datetime

    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    raise TypeError(f"trade_date must be a date, got {type(v).__name__}")
