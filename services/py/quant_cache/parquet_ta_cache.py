"""Parquet-backed :class:`TaCache` adapter (beta).

Layout:

    data/ta/
    └── <code>.parquet   # one stock's analysis history, keyed by asof

Per-file lock + atomic temp-file replace mirror :class:`ParquetSentimentCache`.
The ``payload_json`` column carries the full :class:`TaAnalysis` (with
``Decimal`` / ``date`` / ``datetime`` markers so the dataclass tree
round-trips losslessly).

Expiry: ``asof + 2 trading days @ 00:00 UTC`` — TA on a stale 90D window
is uninteresting; a daily refresh is the worst case. Adjust by changing
:data:`_CACHE_TTL_DAYS`.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Final

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from filelock import FileLock, Timeout
from quant_core.domain.types.ta import (
    SCHEMA_VERSION,
    TaAnalysis,
    TaLevel,
    TaTrend,
)

from quant_cache.errors import CacheBackendUnavailable, CacheCorrupted
from quant_cache.ta_schema import TA_SCHEMA

if TYPE_CHECKING:
    from pathlib import Path

    from quant_core.ports.clock import Clock


_CACHE_TTL_DAYS: Final[int] = 2
_DEFAULT_LOCK_TIMEOUT: Final[float] = 5.0


class ParquetTaCache:
    """One-parquet-per-stock cache for technical analysis payloads."""

    __slots__ = ("_clock", "_lock_timeout", "_root")

    def __init__(
        self,
        root: Path,
        clock: Clock,
        *,
        lock_timeout_sec: float = _DEFAULT_LOCK_TIMEOUT,
    ) -> None:
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise CacheBackendUnavailable(
                f"failed to create ta root: {root}", {"root": str(root)}
            ) from exc
        self._root = root
        self._clock = clock
        self._lock_timeout = lock_timeout_sec

    # -- public API --------------------------------------------------------

    def get(self, code: str, asof: date) -> TaAnalysis | None:
        path = self._path(code)
        if not path.exists():
            return None
        try:
            table = _read_table(path)
        except CacheCorrupted:
            self._safe_unlink(path)
            return None
        if table.num_rows == 0:
            return None
        match = pc.and_(
            pc.equal(table["asof"], pa.scalar(asof, type=pa.date32())),
            pc.equal(
                table["schema_version"], pa.scalar(SCHEMA_VERSION, type=pa.int32())
            ),
        )
        not_expired = pc.greater(
            table["expires_at"],
            pa.scalar(self._clock.now(), type=pa.timestamp("us", tz="UTC")),
        )
        filtered = table.filter(pc.and_(match, not_expired))
        if filtered.num_rows == 0:
            return None
        row = filtered.slice(0, 1).to_pylist()[0]
        try:
            payload = _decode_payload(row["payload_json"])
            return _ta_from_dict(payload)
        except (CacheCorrupted, TypeError, ValueError, KeyError):
            return None

    def put(self, value: TaAnalysis) -> None:
        expires_at = self._compute_expires_at(value.asof)
        if expires_at is None:
            return
        new_row: dict[str, object] = {
            "code": value.code,
            "asof": value.asof,
            "schema_version": int(value.schema_version),
            "fetched_at": _to_utc(value.fetched_at),
            "expires_at": expires_at,
            "payload_json": _encode_payload(_ta_to_dict(value)),
        }
        path = self._path(value.code)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._upsert(path, new_row, key_match=lambda r: r["asof"] == value.asof)

    def invalidate(self, code: str) -> None:
        self._safe_unlink(self._path(code))

    # -- internals ---------------------------------------------------------

    def _path(self, code: str) -> Path:
        return self._root / f"{code}.parquet"

    def _compute_expires_at(self, asof: date) -> datetime | None:
        expires_at = datetime.combine(
            asof + timedelta(days=_CACHE_TTL_DAYS), time.min, tzinfo=UTC
        )
        return None if self._clock.now() >= expires_at else expires_at

    def _upsert(
        self,
        path: Path,
        new_row: dict[str, object],
        *,
        key_match: Any,
    ) -> None:
        try:
            with FileLock(str(path) + ".lock", timeout=self._lock_timeout):
                if path.exists():
                    try:
                        existing = _read_table(path)
                    except CacheCorrupted:
                        existing = TA_SCHEMA.empty_table()
                else:
                    existing = TA_SCHEMA.empty_table()
                kept = [r for r in existing.to_pylist() if not key_match(r)]
                kept.append(new_row)
                table = pa.Table.from_pylist(kept, schema=TA_SCHEMA)
                _atomic_write(path, table)
        except Timeout as exc:
            raise CacheBackendUnavailable(
                f"timed out acquiring lock for {path}",
                {"path": str(path), "timeout_sec": self._lock_timeout},
            ) from exc

    @staticmethod
    def _safe_unlink(path: Path) -> None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            return


# ---------------------------------------------------------------------------
# parquet IO
# ---------------------------------------------------------------------------


def _read_table(path: Path) -> pa.Table:
    try:
        table = pq.read_table(path)
    except (pa.ArrowInvalid, pa.ArrowIOError, OSError) as exc:
        raise CacheCorrupted(
            f"failed to read ta parquet: {path}", {"path": str(path)}
        ) from exc
    if table.schema != TA_SCHEMA:
        raise CacheCorrupted(
            f"ta parquet schema mismatch: {path}", {"path": str(path)}
        )
    return table


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
            f"failed to write ta parquet: {path}", {"path": str(path)}
        ) from exc


# ---------------------------------------------------------------------------
# (de)serialisation — same __type__-tagged JSON encoder as sentiment
# ---------------------------------------------------------------------------


def _encode_payload(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _decode_payload(raw: object) -> Any:
    if not isinstance(raw, str):
        raise CacheCorrupted("payload_json column is not a string", {"type": type(raw).__name__})
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CacheCorrupted(
            "payload_json is not valid JSON",
            {"snippet": raw[:200]},
        ) from exc


def _normalise(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _normalise(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_normalise(v) for v in obj]
    if isinstance(obj, datetime):
        return {"__type__": "datetime", "value": obj.isoformat()}
    if isinstance(obj, date):
        return {"__type__": "date", "value": obj.isoformat()}
    if isinstance(obj, Decimal):
        return {"__type__": "decimal", "value": str(obj)}
    return obj


def _denormalise(obj: Any) -> Any:
    if isinstance(obj, dict):
        if obj.get("__type__") == "datetime" and isinstance(obj.get("value"), str):
            return datetime.fromisoformat(obj["value"])
        if obj.get("__type__") == "date" and isinstance(obj.get("value"), str):
            return date.fromisoformat(obj["value"])
        if obj.get("__type__") == "decimal" and isinstance(obj.get("value"), str):
            return Decimal(obj["value"])
        return {k: _denormalise(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_denormalise(v) for v in obj]
    return obj


def _ta_to_dict(value: TaAnalysis) -> Any:
    return _normalise(asdict(value))


def _ta_level_from_dict(raw: Any) -> TaLevel:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("ta level must be an object")
    return TaLevel(
        price=raw["price"],
        strength=raw["strength"],
        reason=str(raw.get("reason", "")),
    )


def _ta_trend_from_dict(raw: Any) -> TaTrend:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("ta trend must be an object")
    return TaTrend(
        direction=raw["direction"],
        horizon_days=int(raw["horizon_days"]),
        confidence=float(raw["confidence"]),
        rationale=str(raw.get("rationale", "")),
    )


def _ta_from_dict(raw: Any) -> TaAnalysis:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("ta payload must be an object")
    return TaAnalysis(
        code=str(raw["code"]),
        asof=raw["asof"],
        bars_count=int(raw["bars_count"]),
        support_levels=tuple(_ta_level_from_dict(s) for s in raw.get("support_levels", [])),
        resistance_levels=tuple(_ta_level_from_dict(s) for s in raw.get("resistance_levels", [])),
        trend=_ta_trend_from_dict(raw["trend"]),
        patterns=tuple(str(p) for p in raw.get("patterns", [])),
        caveats=tuple(str(c) for c in raw.get("caveats", [])),
        fetched_at=raw["fetched_at"],
        schema_version=int(raw.get("schema_version", SCHEMA_VERSION)),
        provider=str(raw.get("provider", "")),
    )


def _to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)
