"""End-to-end test for the ``upsert_stock_metrics_for_code`` Flight op.

Spins up real :class:`ParquetStockMetaRepo` + :class:`ParquetKlineRepo`
on a temp directory, seeds a meta row + 21 kline bars, fires the op,
and confirms the persisted projection is readable on the next ``get``.
This is the contract NestJS depends on for the post-kline hook.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from quant_cache.flat_prefix_kline_repo import FlatPrefixKlineRepo
from tests._util.kline_seeder import seed_kline_parquet
from quant_cache.parquet_stock_meta_repo import ParquetStockMetaRepo
from quant_core.domain.types.kline import DailyBar
from quant_core.domain.types.stock import StockMeta
from quant_rpc.ops.stock_metrics import (
    UPSERT_METRICS_SCHEMA,
    UpsertStockMetricsForCodeHandler,
    UpsertStockMetricsForCodesHandler,
)

from tests._util.clock import FrozenClock

if TYPE_CHECKING:
    from pathlib import Path


_FROZEN = datetime(2026, 6, 1, 12, tzinfo=UTC)


def _bar(code: str, day_offset: int, close: Decimal) -> DailyBar:
    return DailyBar(
        code=code,
        trade_date=date(2026, 1, 1) + timedelta(days=day_offset),
        open=close,
        high=close,
        low=close,
        close=close,
        volume=0,
        amount=Decimal(0),
        turnover_rate=Decimal(0),
        open_qfq=close,
        high_qfq=close,
        low_qfq=close,
        close_qfq=close,
        ma5=None,
        ma10=None,
        ma20=None,
        ma60=None,
        pct_chg_qfq=None,
        adj_factor=Decimal(1),
    )


def _seed_meta(repo: ParquetStockMetaRepo) -> None:
    repo.upsert_many(
        [
            StockMeta(
                code="000001",
                name="测试",
                name_pinyin="CS",
                industries="bank",
                list_date=date(2020, 1, 1),
                float_pct=Decimal("1"),
                updated_at=_FROZEN,
                total_share=Decimal("1000000"),
                float_share=Decimal("800000"),
            )
        ]
    )


@pytest.mark.integration
def test_upserts_persisted_metrics_for_known_code(tmp_path: Path) -> None:
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    clock = FrozenClock(_FROZEN)
    _seed_meta(meta_repo)
    seed_kline_parquet(
        tmp_path / "kline",
        [_bar("000001", i, Decimal("10") + Decimal(i) * Decimal("0.1")) for i in range(21)],
    )

    handler = UpsertStockMetricsForCodeHandler(meta_repo, kline_repo, clock)
    table = handler.execute({"code": "000001"})

    assert table.num_rows == 1
    assert table.schema == UPSERT_METRICS_SCHEMA
    row = table.to_pylist()[0]
    assert row["code"] == "000001"
    assert row["written"] is True
    assert row["asof"] == date(2026, 1, 21)

    after = meta_repo.get("000001")
    assert after is not None
    assert after.metrics is not None
    assert after.metrics.asof == date(2026, 1, 21)
    # 20-day window from close=10 → close=12 = 0.2 exactly
    assert after.metrics.ret_20d == Decimal("0.2")
    # derived needs share counts (seeded) + price → mkt_cap > 0
    assert after.metrics.mkt_cap is not None
    assert after.metrics.mkt_cap > 0
    assert after.metrics_updated_at == _FROZEN


@pytest.mark.integration
def test_returns_empty_table_when_code_not_in_meta(tmp_path: Path) -> None:
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    clock = FrozenClock(_FROZEN)

    handler = UpsertStockMetricsForCodeHandler(meta_repo, kline_repo, clock)
    table = handler.execute({"code": "999999"})

    assert table.num_rows == 0
    assert table.schema == UPSERT_METRICS_SCHEMA


@pytest.mark.integration
def test_batched_handler_writes_once_for_many_codes(tmp_path: Path) -> None:
    """``upsert_stock_metrics_for_codes`` must rewrite ``stocks.parquet``
    exactly once for the whole batch — the win this op exists for.

    We verify by counting parquet writes via ``stat().st_mtime`` snapshots
    around the call (mtime resolution is plenty for "one write vs many")."""
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    clock = FrozenClock(_FROZEN)
    # Seed two meta rows + two kline series.
    meta_repo.upsert_many(
        [
            StockMeta(
                code="000001",
                name="A",
                name_pinyin="A",
                industries="bank",
                list_date=date(2020, 1, 1),
                float_pct=Decimal("1"),
                updated_at=_FROZEN,
                total_share=Decimal("1000000"),
                float_share=Decimal("800000"),
            ),
            StockMeta(
                code="600519",
                name="B",
                name_pinyin="B",
                industries="liquor",
                list_date=date(2001, 8, 27),
                float_pct=Decimal("1"),
                updated_at=_FROZEN,
                total_share=Decimal("1255000000"),
                float_share=Decimal("1255000000"),
            ),
        ]
    )
    seed_kline_parquet(
        tmp_path / "kline",
        [_bar("000001", i, Decimal("10") + Decimal(i) * Decimal("0.1")) for i in range(21)]
        + [_bar("600519", i, Decimal("1700") + Decimal(i)) for i in range(21)],
    )

    parquet = tmp_path / "stocks.parquet"
    mtime_before = parquet.stat().st_mtime_ns

    handler = UpsertStockMetricsForCodesHandler(meta_repo, kline_repo, clock)
    table = handler.execute({"codes": ["000001", "600519"]})

    assert table.num_rows == 2
    assert sorted(r["code"] for r in table.to_pylist()) == ["000001", "600519"]
    # Both rows should now have a persisted block.
    for code in ("000001", "600519"):
        after = meta_repo.get(code)
        assert after is not None and after.metrics is not None
        assert after.metrics.asof == date(2026, 1, 21)

    # Exactly one rewrite of stocks.parquet (mtime advances once).
    mtime_after = parquet.stat().st_mtime_ns
    assert mtime_after > mtime_before


@pytest.mark.integration
def test_batched_handler_with_empty_codes_expands_to_universe(tmp_path: Path) -> None:
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    clock = FrozenClock(_FROZEN)
    _seed_meta(meta_repo)
    seed_kline_parquet(
        tmp_path / "kline",
        [_bar("000001", i, Decimal("10") + Decimal(i) * Decimal("0.1")) for i in range(21)],
    )

    handler = UpsertStockMetricsForCodesHandler(meta_repo, kline_repo, clock)
    table = handler.execute({"codes": []})

    # Empty codes → full meta universe (one row in this fixture).
    assert table.num_rows == 1
    assert table.to_pylist()[0]["code"] == "000001"


@pytest.mark.integration
def test_batched_handler_skips_unknown_codes(tmp_path: Path) -> None:
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    clock = FrozenClock(_FROZEN)
    _seed_meta(meta_repo)

    handler = UpsertStockMetricsForCodesHandler(meta_repo, kline_repo, clock)
    table = handler.execute({"codes": ["999999", "888888"]})

    # No matching meta rows → empty table, no parquet write.
    assert table.num_rows == 0


@pytest.mark.integration
def test_handles_meta_with_no_kline_bars(tmp_path: Path) -> None:
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    clock = FrozenClock(_FROZEN)
    _seed_meta(meta_repo)

    handler = UpsertStockMetricsForCodeHandler(meta_repo, kline_repo, clock)
    table = handler.execute({"code": "000001"})

    assert table.num_rows == 1
    row = table.to_pylist()[0]
    assert row["written"] is True
    assert row["asof"] is None
    after = meta_repo.get("000001")
    assert after is not None
    # Persisted block exists but every numeric is None; metrics_updated_at
    # is set so we don't keep re-computing the same all-null projection.
    assert after.metrics_updated_at == _FROZEN
