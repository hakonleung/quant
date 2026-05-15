"""Unit tests for the ``list_stock_snapshots`` Flight op.

Two paths under test:

* **Persisted-metrics happy path.** When ``meta.metrics`` is populated
  the handler must serve the row from that block alone — zero kline
  reads. We assert the `_FakeKline` was never called.
* **On-demand recompute fallback.** When ``meta.metrics`` is ``None``
  the handler falls through to ``KlineService.get_last_n`` and
  reconstructs a row identical to the persisted shape.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, cast

import pyarrow as pa
import pytest
from quant_core.domain.pure.compute_metrics import compute_metrics
from quant_core.domain.types.stock import PersistedMetrics, StockMeta
from quant_core.services.kline_service import KlineService
from quant_core.services.stock_meta_service import StockMetaService
from quant_rpc.ops.stock_snapshot import (
    RETURN_WINDOWS,
    STOCK_SNAPSHOT_SCHEMA,
    ListStockSnapshotsHandler,
)

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

    from quant_core.domain.types.kline import DailyBar


UPDATED_AT = datetime(2026, 5, 1, 12, 0, 0, tzinfo=UTC)


def _meta(code: str, *, metrics: PersistedMetrics | None = None) -> StockMeta:
    return StockMeta(
        code=code,
        name=f"name-{code}",
        name_pinyin=code[:4].upper(),
        industries="食品饮料,白酒",
        list_date=date(2001, 8, 27),
        float_pct=Decimal(1),
        updated_at=UPDATED_AT,
        metrics=metrics,
        metrics_updated_at=UPDATED_AT if metrics is not None else None,
    )


def _bar(code: str, day: int, close: str) -> DailyBar:
    # local import — Pylance is happier when the dataclass import isn't
    # shadowed by the TYPE_CHECKING-only alias above.
    from quant_core.domain.types.kline import DailyBar as _DailyBar

    val = Decimal(close)
    return _DailyBar(
        code=code,
        trade_date=date(2026, 5, day),
        open=val,
        high=val,
        low=val,
        close=val,
        volume=1_000,
        amount=Decimal("1000"),
        turnover_rate=Decimal("0.01"),
        open_qfq=val,
        high_qfq=val,
        low_qfq=val,
        close_qfq=val,
        ma5=None,
        ma10=None,
        ma20=None,
        ma60=None,
        pct_chg_qfq=None,
        adj_factor=Decimal("1"),
    )


class _FakeMetaRepo:
    def __init__(self, metas: Iterable[StockMeta]) -> None:
        self._by_code = {m.code: m for m in metas}

    def upsert_many(self, items: Iterable[StockMeta]) -> None:  # pragma: no cover
        for m in items:
            self._by_code[m.code] = m

    def get(self, code: str) -> StockMeta | None:  # pragma: no cover
        return self._by_code.get(code)

    def get_many(self, codes: Sequence[str]) -> list[StockMeta]:
        return [self._by_code[c] for c in codes if c in self._by_code]

    def list_by_industry(self, sw_l2: str) -> list[StockMeta]:  # pragma: no cover
        return [m for m in self._by_code.values() if sw_l2 in m.industries]

    def list_all(self) -> list[StockMeta]:
        return sorted(self._by_code.values(), key=lambda m: m.code)


class _FakeKline:
    """KlineService stand-in. ``calls`` tracks codes we were asked for."""

    def __init__(self, tables: dict[str, pa.Table] | None = None) -> None:
        self._tables = tables or {}
        self.calls: list[str] = []

    def get_last_n(self, code: str, n: int) -> pa.Table:
        del n
        self.calls.append(code)
        return self._tables.get(code, pa.table({"close_qfq": [], "trade_date": []}))


def _kline_for_handler(fake: _FakeKline) -> KlineService:
    """``KlineService`` is a concrete class, not a Protocol — the handler
    only needs ``.get_last_n``, but mypy strict insists on the nominal
    type. ``cast`` is the lightest fix and is fine here per CLAUDE.md
    §1.2.1 (cast is banned only for *external* inputs)."""
    return cast(KlineService, fake)


@pytest.mark.unit
class TestListStockSnapshotsHandler:
    def test_op_and_schema(self) -> None:
        h = ListStockSnapshotsHandler(StockMetaService(_FakeMetaRepo([])), _kline_for_handler(_FakeKline()))
        assert h.op == "list_stock_snapshots"
        assert h.schema == STOCK_SNAPSHOT_SCHEMA

    def test_persisted_metrics_serves_without_kline_call(self) -> None:
        meta = _meta(
            "600519",
            metrics=PersistedMetrics(
                asof=date(2026, 5, 14),
                price=Decimal("1700.50"),
                ret_1d=Decimal("0.01"),
                ret_5d=Decimal("0.05"),
                ret_10d=Decimal("0.10"),
                ret_20d=Decimal("0.20"),
                ret_90d=None,  # young listing window mid-fill
                ret_250d=None,
                mkt_cap=Decimal("2000000000000"),
                float_mkt_cap=Decimal("2000000000000"),
                pe_ttm=Decimal("25"),
                pe_dynamic=None,
                pb=Decimal("12"),
                peg=None,
                gross_margin_ttm=Decimal("0.92"),
            ),
        )
        kline = _FakeKline()
        h = ListStockSnapshotsHandler(StockMetaService(_FakeMetaRepo([meta])), _kline_for_handler(kline))

        table = h.execute({"codes": ["600519"]})

        assert kline.calls == [], "persisted metrics path must not call kline"
        assert table.num_rows == 1
        row = table.to_pylist()[0]
        assert row["code"] == "600519"
        assert row["price"] == "1700.50"
        assert row["asof"] == date(2026, 5, 14)
        assert row["ret_5d"] == "0.05"
        assert row["ret_90d"] is None
        assert row["mkt_cap"] == "2000000000000"

    def test_recompute_fallback_when_metrics_missing(self) -> None:
        bars = [_bar("600519", day=4 + i, close=str(100 + i)) for i in range(11)]
        # Build a kline table mirroring what KlineService.get_last_n returns:
        # one row per bar with at least ``close_qfq`` + ``trade_date``.
        kline_table = pa.table(
            {
                "close_qfq": [b.close_qfq for b in bars],
                "trade_date": [b.trade_date for b in bars],
            }
        )
        meta = _meta("600519", metrics=None)  # legacy row, no projection yet
        kline = _FakeKline({"600519": kline_table})
        h = ListStockSnapshotsHandler(StockMetaService(_FakeMetaRepo([meta])), _kline_for_handler(kline))

        table = h.execute({"codes": ["600519"]})

        assert kline.calls == ["600519"], "missing-metrics path must read kline"
        assert table.num_rows == 1
        row = table.to_pylist()[0]
        # Latest bar's close + date should round-trip into the snapshot row.
        assert row["price"] == str(bars[-1].close_qfq)
        assert row["asof"] == bars[-1].trade_date
        # 1d return: (110 - 109) / 109; we only assert presence here.
        assert row["ret_1d"] is not None
        # Windows larger than the bar count → None.
        assert row["ret_250d"] is None

    def test_recompute_matches_compute_metrics_on_identical_bars(self) -> None:
        """The fallback path must agree with the projector on the same input."""
        bars = [_bar("000001", day=1 + i, close=str(50 + i)) for i in range(30)]
        meta = _meta("000001", metrics=None)
        kline_table = pa.table(
            {
                "close_qfq": [b.close_qfq for b in bars],
                "trade_date": [b.trade_date for b in bars],
            }
        )
        kline = _FakeKline({"000001": kline_table})
        h = ListStockSnapshotsHandler(StockMetaService(_FakeMetaRepo([meta])), _kline_for_handler(kline))

        table = h.execute({"codes": ["000001"]})
        row = table.to_pylist()[0]
        expected = compute_metrics(meta, bars)

        assert row["price"] == str(expected.price)
        for window in RETURN_WINDOWS:
            field = f"ret_{window}d"
            actual = row[field]
            wanted = getattr(expected, field)
            if wanted is None:
                assert actual is None, f"{field}: expected None, got {actual!r}"
            else:
                assert actual is not None
                # Both go through ``str(Decimal)`` — exact equality.
                assert actual == str(wanted), f"{field}: {actual} != {wanted}"

    def test_empty_codes_expands_to_full_universe(self) -> None:
        ms = [_meta("000001"), _meta("000002")]
        kline = _FakeKline()
        h = ListStockSnapshotsHandler(StockMetaService(_FakeMetaRepo(ms)), _kline_for_handler(kline))
        table = h.execute({"codes": []})
        assert table.column("code").to_pylist() == ["000001", "000002"]

    def test_unknown_code_silently_dropped(self) -> None:
        meta = _meta("600519")
        h = ListStockSnapshotsHandler(
            StockMetaService(_FakeMetaRepo([meta])), _kline_for_handler(_FakeKline())
        )
        table = h.execute({"codes": ["600519", "999999"]})
        assert table.column("code").to_pylist() == ["600519"]

    def test_codes_must_be_list(self) -> None:
        from quant_core.errors import QuantError

        h = ListStockSnapshotsHandler(StockMetaService(_FakeMetaRepo([])), _kline_for_handler(_FakeKline()))
        with pytest.raises(QuantError) as excinfo:
            h.execute({"codes": "600519"})
        assert excinfo.value.code == "INVALID_ARGUMENT"

    def test_codes_missing_raises(self) -> None:
        from quant_core.errors import QuantError

        h = ListStockSnapshotsHandler(StockMetaService(_FakeMetaRepo([])), _kline_for_handler(_FakeKline()))
        with pytest.raises(QuantError) as excinfo:
            h.execute({})
        assert excinfo.value.code == "INVALID_ARGUMENT"
