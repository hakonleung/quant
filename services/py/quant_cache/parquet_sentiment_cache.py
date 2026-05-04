"""Parquet-backed :class:`SentimentCache` adapter (modules/06-sentiment-analysis.md §5.2).

Layout — modelled on :class:`ParquetKlineRepo`:

    data/sentiment/
    ├── stock/
    │   ├── 002980.parquet          # 一只股票多条 (asof, window_days) 历史
    │   └── 600519.parquet
    └── market/
        └── <codes_hash>.parquet    # 一组代码的多条历史

Per-file ``filelock.FileLock`` serialises mutating operations
(``put_stock`` / ``put_market`` / ``invalidate_stock``); reads are
lock-free because writes are atomic via ``tempfile`` + ``os.replace`` —
a concurrent reader sees either the previous file or the new one, never
a partial parquet.

Expiry policy:
    ``expires_at = datetime(asof + 2 days, 00:00 UTC)`` is materialised
    as a column on write. Reads filter on it, so stale rows are skipped
    without a separate eviction job. ``invalidate_stock`` deletes the
    file outright.

Schema versioning:
    ``schema_version`` is also a column. A row written at v1 is
    invisible to a v2 reader (filtered at read time) — the Parquet file
    survives intact, no migration script needed.
"""

from __future__ import annotations

import hashlib
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
from quant_core.domain.types.sentiment import (
    SCHEMA_VERSION,
    CompetitiveLandscape,
    CompetitorInfo,
    Evidence,
    IndustryTrend,
    Insight,
    MarketSentiment,
    MarketTrend,
    PriceSignal,
    ProductInfo,
    ResearchTarget,
    StockSentiment,
    StyleSignal,
    ThemeCluster,
    ThemeTag,
)

from quant_cache.errors import CacheBackendUnavailable, CacheCorrupted
from quant_cache.sentiment_schema import (
    MARKET_SENTIMENT_SCHEMA,
    STOCK_SENTIMENT_SCHEMA,
)

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

    from quant_core.ports.clock import Clock

_CACHE_TTL_DAYS: Final[int] = 2
"""``asof`` 之后多少日历天 payload 失效。"""

_HASH_LEN: Final[int] = 32
"""多股 codes_hash 的 sha256 截断长度（保持 Windows 友好的文件名）。"""

_DEFAULT_LOCK_TIMEOUT: Final[float] = 5.0


class ParquetSentimentCache:
    """One-parquet-per-entity adapter for :class:`SentimentCache`.

    Args:
        root: 根目录；``stock/`` 和 ``market/`` 子目录会在首次写入时创建。
        clock: 用于计算 ``expires_at`` + 在读取时判断是否过期。
        lock_timeout_sec: 写入加锁等待上限。
    """

    __slots__ = ("_clock", "_lock_timeout", "_market_dir", "_root", "_stock_dir")

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
                f"failed to create sentiment root: {root}", {"root": str(root)}
            ) from exc
        self._root = root
        self._stock_dir = root / "stock"
        self._market_dir = root / "market"
        self._clock = clock
        self._lock_timeout = lock_timeout_sec

    # -- 单股 -----------------------------------------------------------------

    def get_stock(self, code: str, asof: date, window_days: int) -> StockSentiment | None:
        path = self._stock_path(code)
        if not path.exists():
            return None
        try:
            table = _read_table(path, STOCK_SENTIMENT_SCHEMA)
        except CacheCorrupted:
            # Stomped file — quietly drop it; the next put_stock will rebuild.
            self._safe_unlink(path)
            return None
        row = self._select_row(
            table,
            _and_chunked(
                pc.equal(table["asof"], pa.scalar(asof, type=pa.date32())),
                pc.equal(table["window_days"], pa.scalar(window_days, type=pa.int32())),
                pc.equal(table["schema_version"], pa.scalar(SCHEMA_VERSION, type=pa.int32())),
            ),
        )
        if row is None:
            return None
        try:
            payload = _decode_payload(row["payload_json"])
            value = _stock_from_dict(payload)
        except (CacheCorrupted, TypeError, ValueError, KeyError):
            return None
        if value.code != code or value.asof != asof or value.window_days != window_days:
            return None
        return value

    def put_stock(self, value: StockSentiment) -> None:
        expires_at = self._compute_expires_at(value.asof)
        if expires_at is None:
            return
        new_row: dict[str, object] = {
            "code": value.code,
            "asof": value.asof,
            "window_days": int(value.window_days),
            "schema_version": int(value.schema_version),
            "fetched_at": value.fetched_at,
            "expires_at": expires_at,
            "sentiment_score": float(value.sentiment_score),
            "payload_json": _encode_payload(_stock_to_dict(value)),
        }
        path = self._stock_path(value.code)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._upsert_row(
            path,
            STOCK_SENTIMENT_SCHEMA,
            new_row,
            key_match=lambda row: (
                row["asof"] == value.asof
                and int(row["window_days"]) == int(value.window_days)
            ),
        )

    def invalidate_stock(self, code: str) -> None:
        # File-level invalidation: drop the whole per-code parquet so every
        # historical asof for this stock disappears in one atomic op.
        self._safe_unlink(self._stock_path(code))

    # -- 多股聚合 -------------------------------------------------------------

    def get_market(
        self,
        codes: Sequence[str],
        asof: date,
        window_days: int,
    ) -> MarketSentiment | None:
        codes_hash = _market_hash(codes, window_days)
        path = self._market_path(codes_hash)
        if not path.exists():
            return None
        try:
            table = _read_table(path, MARKET_SENTIMENT_SCHEMA)
        except CacheCorrupted:
            self._safe_unlink(path)
            return None
        row = self._select_row(
            table,
            _and_chunked(
                pc.equal(table["asof"], pa.scalar(asof, type=pa.date32())),
                pc.equal(table["window_days"], pa.scalar(window_days, type=pa.int32())),
                pc.equal(table["schema_version"], pa.scalar(SCHEMA_VERSION, type=pa.int32())),
            ),
        )
        if row is None:
            return None
        try:
            payload = _decode_payload(row["payload_json"])
            value = _market_from_dict(payload)
        except (CacheCorrupted, TypeError, ValueError, KeyError):
            return None
        if value.asof != asof or value.window_days != window_days:
            return None
        return value

    def put_market(self, value: MarketSentiment) -> None:
        expires_at = self._compute_expires_at(value.asof)
        if expires_at is None:
            return
        codes = tuple(value.per_stock.keys())
        codes_hash = _market_hash(codes, value.window_days)
        canonical = ",".join(sorted({c for c in codes if c}))
        new_row: dict[str, object] = {
            "codes_hash": codes_hash,
            "codes_canonical": canonical,
            "asof": value.asof,
            "window_days": int(value.window_days),
            "schema_version": int(value.schema_version),
            "fetched_at": value.fetched_at,
            "expires_at": expires_at,
            "payload_json": _encode_payload(_market_to_dict(value)),
        }
        path = self._market_path(codes_hash)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._upsert_row(
            path,
            MARKET_SENTIMENT_SCHEMA,
            new_row,
            key_match=lambda row: (
                row["asof"] == value.asof
                and int(row["window_days"]) == int(value.window_days)
            ),
        )

    # -- internals ------------------------------------------------------------

    def _stock_path(self, code: str) -> Path:
        return self._stock_dir / f"{code}.parquet"

    def _market_path(self, codes_hash: str) -> Path:
        return self._market_dir / f"{codes_hash}.parquet"

    def _compute_expires_at(self, asof: date) -> datetime | None:
        """``asof + 2 天 @ 00:00 UTC``；当前时刻已超过返回 ``None``（不写）。"""
        expires_at = datetime.combine(
            asof + timedelta(days=_CACHE_TTL_DAYS), time.min, tzinfo=UTC
        )
        return None if self._clock.now() >= expires_at else expires_at

    def _select_row(
        self,
        table: pa.Table,
        match: pa.Array,
    ) -> dict[str, object] | None:
        """Filter ``table`` by ``match`` + the not-yet-expired predicate.

        Returns the first matching row as a dict, or ``None`` on no hit.
        """
        if table.num_rows == 0:
            return None
        not_expired = pc.greater(
            table["expires_at"],
            pa.scalar(self._clock.now(), type=pa.timestamp("us", tz="UTC")),
        )
        filtered = table.filter(_and_chunked(match, not_expired))
        if filtered.num_rows == 0:
            return None
        rows: list[dict[str, object]] = filtered.slice(0, 1).to_pylist()
        return rows[0]

    def _upsert_row(
        self,
        path: Path,
        schema: pa.Schema,
        new_row: dict[str, object],
        *,
        key_match: Any,
    ) -> None:
        """Insert-or-replace ``new_row`` under per-file lock.

        ``key_match`` is a callable ``row_dict -> bool`` selecting the row
        that ``new_row`` should replace (typically ``(asof, window_days)``
        equality). All non-matching rows are kept verbatim — the per-file
        history of a stock / hash grows over time until ``invalidate``.
        """
        try:
            with FileLock(str(path) + ".lock", timeout=self._lock_timeout):
                if path.exists():
                    try:
                        existing = _read_table(path, schema)
                    except CacheCorrupted:
                        existing = schema.empty_table()
                else:
                    existing = schema.empty_table()
                kept = [r for r in existing.to_pylist() if not key_match(r)]
                kept.append(new_row)
                table = pa.Table.from_pylist(kept, schema=schema)
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


# -- key / encoding helpers ---------------------------------------------------


def _and_chunked(*parts: pa.ChunkedArray) -> pa.ChunkedArray:
    """Logical AND across pyarrow ``ChunkedArray`` masks.

    pyarrow's ``ChunkedArray`` does not implement ``__and__`` (Python's
    ``&`` operator); ``pc.and_`` does the right thing chunk-by-chunk.
    """
    if not parts:
        raise ValueError("_and_chunked requires at least one operand")
    out = parts[0]
    for p in parts[1:]:
        out = pc.and_(out, p)
    return out


def _market_hash(codes: Sequence[str], window_days: int) -> str:
    canonical = ",".join(sorted({c for c in codes if c}))
    digest = hashlib.sha256(f"{canonical}|w={window_days}".encode()).hexdigest()
    return digest[:_HASH_LEN]


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


# -- parquet IO helpers (mirroring ParquetKlineRepo) -------------------------


def _read_table(path: Path, expected_schema: pa.Schema) -> pa.Table:
    try:
        table = pq.read_table(path)
    except (pa.ArrowInvalid, pa.ArrowIOError, OSError) as exc:
        raise CacheCorrupted(
            f"failed to read sentiment parquet: {path}", {"path": str(path)}
        ) from exc
    if table.schema != expected_schema:
        raise CacheCorrupted(
            f"sentiment parquet schema mismatch: {path}",
            {"path": str(path)},
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
            f"failed to write sentiment parquet: {path}", {"path": str(path)}
        ) from exc


# -- (de)serialisation -------------------------------------------------------
#
# Same encoding as the original JSON-blob layout — kept here so domain
# types stay free of JSON dependency.


def _stock_to_dict(value: StockSentiment) -> Any:
    return _normalise(asdict(value))


def _market_to_dict(value: MarketSentiment) -> Any:
    return _normalise(asdict(value))


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


def _evidence_from_dict(raw: Any) -> Evidence:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("evidence must be an object")
    return Evidence(
        source_type=raw["source_type"],
        quoted_text=raw["quoted_text"],
        url=raw["url"],
        published_at=raw.get("published_at"),
    )


def _evidence_tuple(raw: Any) -> tuple[Evidence, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise ValueError("evidence list must be an array")
    return tuple(_evidence_from_dict(e) for e in raw)


def _insight_from_dict(raw: Any) -> Insight:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("insight must be an object")
    return Insight(
        summary=raw["summary"],
        direction=raw["direction"],
        confidence=float(raw["confidence"]),
        is_rumor=bool(raw["is_rumor"]),
        evidence=_evidence_tuple(raw.get("evidence")),
    )


def _theme_tag_from_dict(raw: Any) -> ThemeTag:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("theme tag must be an object")
    return ThemeTag(
        label=raw["label"],
        relevance=float(raw["relevance"]),
        rationale=raw["rationale"],
        evidence=_evidence_tuple(raw.get("evidence")),
    )


def _product_info_from_dict(raw: Any) -> ProductInfo:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("product info must be an object")
    share = raw.get("revenue_share_pct")
    return ProductInfo(
        name=raw["name"],
        revenue_share_pct=float(share) if share is not None else None,
        note=raw.get("note"),
    )


def _price_signal_from_dict(raw: Any) -> PriceSignal:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("price signal must be an object")
    return PriceSignal(
        product=raw["product"],
        change=raw["change"],
        horizon=raw["horizon"],
        evidence=_evidence_tuple(raw.get("evidence")),
        magnitude=raw.get("magnitude"),
    )


def _research_target_from_dict(raw: Any) -> ResearchTarget:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("research target must be an object")
    return ResearchTarget(
        broker=raw["broker"],
        url=raw["url"],
        rating=raw.get("rating"),
        target_price=raw.get("target_price"),
        target_upside_pct=raw.get("target_upside_pct"),
        horizon_months=raw.get("horizon_months"),
        report_date=raw.get("report_date"),
    )


def _competitor_info_from_dict(raw: Any) -> CompetitorInfo:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("competitor info must be an object")
    return CompetitorInfo(
        name=raw["name"],
        relation=raw["relation"],
        threat_level=raw["threat_level"],
        note=raw["note"],
        evidence=_evidence_tuple(raw.get("evidence")),
    )


def _competitive_landscape_from_dict(raw: Any) -> CompetitiveLandscape | None:
    if raw is None:
        return None
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        return None
    share = raw.get("market_share_pct")
    return CompetitiveLandscape(
        market_position=raw["market_position"],
        summary=raw["summary"],
        competitors=tuple(_competitor_info_from_dict(c) for c in raw.get("competitors", [])),
        moats=tuple(raw.get("moats", [])),
        risks=tuple(raw.get("risks", [])),
        evidence=_evidence_tuple(raw.get("evidence")),
        market_share_pct=float(share) if isinstance(share, (int, float)) else None,
    )


def _stock_from_dict(raw: Any) -> StockSentiment:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("stock sentiment must be an object")
    return StockSentiment(
        code=raw["code"],
        asof=raw["asof"],
        window_days=int(raw["window_days"]),
        sentiment_score=float(raw["sentiment_score"]),
        fetched_at=raw["fetched_at"],
        schema_version=int(raw.get("schema_version", SCHEMA_VERSION)),
        result=str(raw.get("result", "")),
        core_drivers=tuple(_insight_from_dict(i) for i in raw.get("core_drivers", [])),
        m_and_a=tuple(_insight_from_dict(i) for i in raw.get("m_and_a", [])),
        hot_themes=tuple(_theme_tag_from_dict(t) for t in raw.get("hot_themes", [])),
        core_products=tuple(_product_info_from_dict(p) for p in raw.get("core_products", [])),
        price_signals=tuple(_price_signal_from_dict(s) for s in raw.get("price_signals", [])),
        supply_demand=tuple(_insight_from_dict(i) for i in raw.get("supply_demand", [])),
        research_targets=tuple(_research_target_from_dict(r) for r in raw.get("research_targets", [])),
        competitive_landscape=_competitive_landscape_from_dict(raw.get("competitive_landscape")),
        coverage_gaps=tuple(raw.get("coverage_gaps", [])),
        caveats=tuple(raw.get("caveats", [])),
    )


def _theme_cluster_from_dict(raw: Any) -> ThemeCluster:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("theme cluster must be an object")
    return ThemeCluster(
        theme_label=raw["theme_label"],
        member_codes=tuple(raw.get("member_codes", [])),
        related_industries=tuple(raw.get("related_industries", [])),
        heat_score=float(raw["heat_score"]),
        trend=raw["trend"],
        summary=raw["summary"],
        top_evidence=_evidence_tuple(raw.get("top_evidence")),
    )


def _style_signal_from_dict(raw: Any) -> StyleSignal:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("style signal must be an object")
    return StyleSignal(
        name=raw["name"],
        confidence=float(raw["confidence"]),
        rationale=raw["rationale"],
        supporting_evidence=_evidence_tuple(raw.get("supporting_evidence")),
    )


def _market_trend_from_dict(raw: Any) -> MarketTrend:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("market trend must be an object")
    return MarketTrend(
        summary=raw["summary"],
        style_signals=tuple(_style_signal_from_dict(s) for s in raw.get("style_signals", [])),
        caveats=tuple(raw.get("caveats", [])),
    )


def _industry_trend_from_dict(raw: Any) -> IndustryTrend:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("industry trend must be an object")
    return IndustryTrend(
        industry=raw["industry"],
        summary=raw["summary"],
        direction=raw["direction"],
        drivers=tuple(raw.get("drivers", [])),
        risks=tuple(raw.get("risks", [])),
        related_themes=tuple(raw.get("related_themes", [])),
    )


def _market_from_dict(raw: Any) -> MarketSentiment:
    raw = _denormalise(raw)
    if not isinstance(raw, dict):
        raise ValueError("market sentiment must be an object")
    per_stock_raw = raw.get("per_stock", {})
    if not isinstance(per_stock_raw, dict):
        raise ValueError("per_stock must be an object")
    per_stock = {code: _stock_from_dict(payload) for code, payload in per_stock_raw.items()}
    return MarketSentiment(
        asof=raw["asof"],
        window_days=int(raw["window_days"]),
        fetched_at=raw["fetched_at"],
        per_stock=per_stock,
        schema_version=int(raw.get("schema_version", SCHEMA_VERSION)),
        theme_clusters=tuple(_theme_cluster_from_dict(c) for c in raw.get("theme_clusters", [])),
        market_trend=_market_trend_from_dict(raw.get("market_trend", {"summary": ""})),
        industry_trends=tuple(_industry_trend_from_dict(t) for t in raw.get("industry_trends", [])),
        caveats=tuple(raw.get("caveats", [])),
    )
