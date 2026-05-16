"""End-to-end test for the ``compute_stock_metrics_for_code`` Flight op.

The compute handlers project (meta + kline) → metrics row in Arrow.
Storage-unify-rollout moved the actual parquet write to NestJS's
``LocalStockMetaWriterService``, so this test only verifies the
returned table — there is no longer a Python-side ``upsert_many``
side effect to assert against.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from quant_cache.flat_prefix_kline_repo import FlatPrefixKlineRepo
from quant_cache.parquet_stock_meta_repo import ParquetStockMetaRepo
from quant_core.domain.types.kline import DailyBar
from quant_core.domain.types.stock import StockMeta
from quant_rpc.ops.stock_metrics import (
    COMPUTE_METRICS_SCHEMA,
    ComputeStockMetricsForCodeHandler,
    ComputeStockMetricsForCodesHandler,
)

from tests._util.kline_seeder import seed_kline_parquet
from tests._util.stock_meta_seeder import seed_stock_meta_parquet

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


def _seed_meta(meta_path: Path) -> None:
    seed_stock_meta_parquet(
        meta_path,
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
        ],
    )


@pytest.mark.integration
def test_computes_metrics_for_known_code(tmp_path: Path) -> None:
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    _seed_meta(tmp_path / "stocks.parquet")
    seed_kline_parquet(
        tmp_path / "kline",
        [_bar("000001", i, Decimal("10") + Decimal(i) * Decimal("0.1")) for i in range(21)],
    )

    handler = ComputeStockMetricsForCodeHandler(meta_repo, kline_repo)
    table = handler.execute({"code": "000001"})

    assert table.num_rows == 1
    assert table.schema == COMPUTE_METRICS_SCHEMA
    row = table.to_pylist()[0]
    assert row["code"] == "000001"
    assert row["asof"] == date(2026, 1, 21)
    # 20-day window from close=10 → close=12 = 0.2 exactly
    assert row["ret_20d"] == "0.2"
    # derived needs share counts (seeded) + price → mkt_cap > 0
    assert row["mkt_cap"] is not None
    assert Decimal(row["mkt_cap"]) > 0


@pytest.mark.integration
def test_returns_empty_table_when_code_not_in_meta(tmp_path: Path) -> None:
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")

    handler = ComputeStockMetricsForCodeHandler(meta_repo, kline_repo)
    table = handler.execute({"code": "999999"})

    assert table.num_rows == 0
    assert table.schema == COMPUTE_METRICS_SCHEMA


@pytest.mark.integration
def test_batched_handler_returns_one_row_per_code(tmp_path: Path) -> None:
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    # Seed two meta rows + two kline series.
    seed_stock_meta_parquet(
        tmp_path / "stocks.parquet",
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
        ],
    )
    seed_kline_parquet(
        tmp_path / "kline",
        [_bar("000001", i, Decimal("10") + Decimal(i) * Decimal("0.1")) for i in range(21)]
        + [_bar("600519", i, Decimal("1700") + Decimal(i)) for i in range(21)],
    )

    handler = ComputeStockMetricsForCodesHandler(meta_repo, kline_repo)
    table = handler.execute({"codes": ["000001", "600519"]})

    assert table.num_rows == 2
    rows = table.to_pylist()
    assert sorted(r["code"] for r in rows) == ["000001", "600519"]
    for row in rows:
        assert row["asof"] == date(2026, 1, 21)
        assert row["mkt_cap"] is not None


@pytest.mark.integration
def test_batched_handler_with_empty_codes_expands_to_universe(tmp_path: Path) -> None:
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    _seed_meta(tmp_path / "stocks.parquet")
    seed_kline_parquet(
        tmp_path / "kline",
        [_bar("000001", i, Decimal("10") + Decimal(i) * Decimal("0.1")) for i in range(21)],
    )

    handler = ComputeStockMetricsForCodesHandler(meta_repo, kline_repo)
    table = handler.execute({"codes": []})

    # Empty codes → full meta universe (one row in this fixture).
    assert table.num_rows == 1
    assert table.to_pylist()[0]["code"] == "000001"


@pytest.mark.integration
def test_batched_handler_skips_unknown_codes(tmp_path: Path) -> None:
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    _seed_meta(tmp_path / "stocks.parquet")

    handler = ComputeStockMetricsForCodesHandler(meta_repo, kline_repo)
    table = handler.execute({"codes": ["999999", "888888"]})

    # No matching meta rows → empty table.
    assert table.num_rows == 0


@pytest.mark.integration
def test_handles_meta_with_no_kline_bars(tmp_path: Path) -> None:
    meta_repo = ParquetStockMetaRepo(tmp_path / "stocks.parquet")
    kline_repo = FlatPrefixKlineRepo(root=tmp_path / "kline")
    _seed_meta(tmp_path / "stocks.parquet")

    handler = ComputeStockMetricsForCodeHandler(meta_repo, kline_repo)
    table = handler.execute({"code": "000001"})

    assert table.num_rows == 1
    row = table.to_pylist()[0]
    assert row["asof"] is None
    assert row["metrics_price"] is None
    assert row["mkt_cap"] is None
