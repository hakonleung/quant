"""Unit tests for :class:`TaService`.

Covers the cache-then-LLM happy path, ``bypass_cache=True``, prompt
shape, and every LLM-output validation guard. Both the LLM and the
kline service are exercised through fakes so the test stays a pure
unit (no parquet, no network).
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, cast

import pyarrow as pa
import pytest
from quant_cache.kline_schema import KLINE_SCHEMA, daily_bar_to_row
from quant_core.domain.types.kline import DailyBar
from quant_core.errors import QuantError
from quant_core.services.ta_service import TaService, TaServiceConfig

from tests._util.clock import FrozenClock
from tests._util.stock_meta_fixtures import SEED

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

    from quant_core.domain.types.stock import StockMeta
    from quant_core.domain.types.ta import TaAnalysis


# -- fakes -------------------------------------------------------------------


class _FakeMetaRepo:
    def __init__(self, items: Iterable[StockMeta]) -> None:
        self._by_code = {m.code: m for m in items}

    def upsert_many(self, items: Iterable[StockMeta]) -> None:
        for m in items:
            self._by_code[m.code] = m

    def get(self, code: str) -> StockMeta | None:
        return self._by_code.get(code)

    def get_many(self, codes: Sequence[str]) -> list[StockMeta]:
        return [self._by_code[c] for c in codes if c in self._by_code]

    def list_by_industry(self, sw_l2: str) -> list[StockMeta]:
        return [m for m in self._by_code.values() if sw_l2 in m.industries]

    def list_all(self) -> list[StockMeta]:
        return list(self._by_code.values())


class _FakeKlineService:
    """Minimal :class:`KlineService` shim returning a canned table."""

    def __init__(self, bars_by_code: dict[str, Sequence[DailyBar]]) -> None:
        self._bars = {code: list(b) for code, b in bars_by_code.items()}
        self.calls: list[tuple[str, int]] = []

    def get_last_n(self, code: str, n: int) -> pa.Table:
        self.calls.append((code, n))
        bars = self._bars.get(code, [])
        if not bars:
            return KLINE_SCHEMA.empty_table()
        rows = [daily_bar_to_row(b) for b in bars]
        return pa.Table.from_pylist(rows, schema=KLINE_SCHEMA)


class _FakeTaCache:
    def __init__(self) -> None:
        self.store: dict[tuple[str, date], TaAnalysis] = {}
        self.put_calls: int = 0

    def get(self, code: str, asof: date) -> TaAnalysis | None:
        return self.store.get((code, asof))

    def put(self, value: TaAnalysis) -> None:
        self.put_calls += 1
        self.store[(value.code, value.asof)] = value

    def invalidate(self, code: str) -> None:
        self.store = {k: v for k, v in self.store.items() if k[0] != code}


class _ScriptedLLM:
    """LLM stub that returns successive responses; raises if exhausted."""

    name: str = "fake-llm"

    def __init__(self, responses: list[str]) -> None:
        self._responses = responses
        self.calls: list[dict[str, str]] = []

    def complete_json(self, *, system: str, user: str) -> str:
        self.calls.append({"system": system, "user": user})
        if not self._responses:
            raise QuantError("LLM_FAILED", "no scripted responses left")
        return self._responses.pop(0)

    def complete_with_web_search(
        self, *, system: str, user: str, max_searches: int
    ) -> str:
        raise NotImplementedError


# -- helpers -----------------------------------------------------------------


_ASOF: date = date(2026, 5, 6)


def _make_bars(code: str, *, n: int = 90) -> list[DailyBar]:
    """Generate ``n`` synthetic frozen bars ending at ``_ASOF``."""
    base = Decimal("10.00")
    out: list[DailyBar] = []
    for i in range(n):
        # Walk forward ``i`` calendar days from a start date so trade_date
        # values are unique and ordered ascending.
        d = date(2026, 1, 1)
        from datetime import timedelta

        d = d + timedelta(days=i)
        price = base + Decimal(i) * Decimal("0.10")
        out.append(
            DailyBar(
                code=code,
                trade_date=d,
                open=price,
                high=price + Decimal("0.20"),
                low=price - Decimal("0.20"),
                close=price + Decimal("0.05"),
                volume=1_000_000 + i,
                amount=Decimal("10000000.00"),
                turnover_rate=Decimal("0.012345"),
                open_qfq=price,
                high_qfq=price + Decimal("0.20"),
                low_qfq=price - Decimal("0.20"),
                close_qfq=price + Decimal("0.05"),
                ma5=price,
                ma10=price,
                ma20=price,
                ma60=price,
                pct_chg_qfq=Decimal("0.001000"),
                adj_factor=Decimal("1.0000"),
            )
        )
    # Force last bar's date to _ASOF so the cache key matches.
    last = out[-1]
    out[-1] = DailyBar(
        code=last.code,
        trade_date=_ASOF,
        open=last.open,
        high=last.high,
        low=last.low,
        close=last.close,
        volume=last.volume,
        amount=last.amount,
        turnover_rate=last.turnover_rate,
        open_qfq=last.open_qfq,
        high_qfq=last.high_qfq,
        low_qfq=last.low_qfq,
        close_qfq=last.close_qfq,
        ma5=last.ma5,
        ma10=last.ma10,
        ma20=last.ma20,
        ma60=last.ma60,
        pct_chg_qfq=last.pct_chg_qfq,
        adj_factor=last.adj_factor,
    )
    return out


def _good_payload() -> dict[str, object]:
    return {
        "support_levels": [
            {"price": "10.5", "strength": "strong", "reason": "MA60"},
            {"price": "9.8", "strength": "medium", "reason": "前低"},
        ],
        "resistance_levels": [
            {"price": "12.0", "strength": "weak", "reason": "上方筹码"},
        ],
        "trend": {
            "direction": "up",
            "horizon_days": 10,
            "confidence": 0.7,
            "rationale": "MA 多头排列",
        },
        "patterns": ["上升三角形"],
        "caveats": [],
    }


def _build_service(
    *,
    llm_responses: list[str],
    bars: dict[str, list[DailyBar]] | None = None,
) -> tuple[TaService, _ScriptedLLM, _FakeTaCache, _FakeKlineService]:
    if bars is None:
        bars = {"600519": _make_bars("600519")}
    llm = _ScriptedLLM(llm_responses)
    cache = _FakeTaCache()
    kline = _FakeKlineService(bars)
    meta_repo = _FakeMetaRepo(SEED)
    clock = FrozenClock(datetime(2026, 5, 6, 8, 0, 0, tzinfo=UTC))
    service = TaService(
        llm=cast("Any", llm),
        kline_service=cast("Any", kline),
        cache=cast("Any", cache),
        meta_repo=cast("Any", meta_repo),
        clock=cast("Any", clock),
        config=TaServiceConfig(bars_window=90),
    )
    return service, llm, cache, kline


# -- tests -------------------------------------------------------------------


def test_analyze_one_writes_to_cache_and_returns_payload() -> None:
    service, llm, cache, kline = _build_service(
        llm_responses=[json.dumps(_good_payload())]
    )
    result = service.analyze_one("600519")
    assert result.code == "600519"
    assert result.asof == _ASOF
    assert result.bars_count == 90
    assert len(result.support_levels) == 2
    assert result.support_levels[0].price == Decimal("10.5")
    assert result.trend.direction == "up"
    assert result.trend.horizon_days == 10
    assert cache.put_calls == 1
    assert kline.calls == [("600519", 90)]
    assert len(llm.calls) == 1
    # Prompt sanity — bars CSV header is in the user prompt.
    assert "date,open,high,low,close,volume,ma5,ma10,ma20,ma60" in llm.calls[0]["user"]


def test_cache_hit_short_circuits_llm() -> None:
    service, llm, cache, _kline = _build_service(
        llm_responses=[json.dumps(_good_payload())]
    )
    first = service.analyze_one("600519")
    assert len(llm.calls) == 1
    second = service.analyze_one("600519")
    assert second == first
    assert len(llm.calls) == 1  # no second LLM call
    assert cache.put_calls == 1


def test_bypass_cache_forces_fresh_llm_call() -> None:
    service, llm, _cache, _kline = _build_service(
        llm_responses=[json.dumps(_good_payload()), json.dumps(_good_payload())]
    )
    service.analyze_one("600519")
    service.analyze_one("600519", bypass_cache=True)
    assert len(llm.calls) == 2


def test_unknown_stock_raises_stock_not_found() -> None:
    service, _llm, _cache, _kline = _build_service(
        llm_responses=[],
        bars={"600519": _make_bars("600519")},
    )
    with pytest.raises(QuantError) as excinfo:
        service.analyze_one("999999")
    assert excinfo.value.code == "STOCK_NOT_FOUND"


def test_no_bars_raises_kline_data_missing() -> None:
    service, _llm, _cache, _kline = _build_service(
        llm_responses=[],
        bars={"600519": []},
    )
    with pytest.raises(QuantError) as excinfo:
        service.analyze_one("600519")
    assert excinfo.value.code == "KLINE_DATA_MISSING"


def test_invalid_json_raises_llm_failed() -> None:
    service, _llm, _cache, _kline = _build_service(llm_responses=["not json at all"])
    with pytest.raises(QuantError) as excinfo:
        service.analyze_one("600519")
    assert excinfo.value.code == "LLM_FAILED"


def test_payload_strips_markdown_fences() -> None:
    fenced = "```json\n" + json.dumps(_good_payload()) + "\n```"
    service, _llm, _cache, _kline = _build_service(llm_responses=[fenced])
    result = service.analyze_one("600519")
    assert result.trend.direction == "up"


def test_missing_trend_raises_llm_failed() -> None:
    bad = _good_payload()
    del bad["trend"]
    service, _llm, _cache, _kline = _build_service(llm_responses=[json.dumps(bad)])
    with pytest.raises(QuantError) as excinfo:
        service.analyze_one("600519")
    assert excinfo.value.code == "LLM_FAILED"


def test_invalid_trend_direction_raises() -> None:
    bad = _good_payload()
    bad["trend"] = {**cast("dict", bad["trend"]), "direction": "moonbeam"}
    service, _llm, _cache, _kline = _build_service(llm_responses=[json.dumps(bad)])
    with pytest.raises(QuantError) as excinfo:
        service.analyze_one("600519")
    assert excinfo.value.code == "LLM_FAILED"


def test_invalid_horizon_days_raises() -> None:
    bad = _good_payload()
    bad["trend"] = {**cast("dict", bad["trend"]), "horizon_days": 0}
    service, _llm, _cache, _kline = _build_service(llm_responses=[json.dumps(bad)])
    with pytest.raises(QuantError) as excinfo:
        service.analyze_one("600519")
    assert excinfo.value.code == "LLM_FAILED"


def test_levels_with_invalid_strength_are_dropped() -> None:
    bad = _good_payload()
    bad["support_levels"] = [
        {"price": "10.5", "strength": "uncertain", "reason": "x"},
        {"price": "9.8", "strength": "strong", "reason": "y"},
    ]
    service, _llm, _cache, _kline = _build_service(llm_responses=[json.dumps(bad)])
    result = service.analyze_one("600519")
    assert len(result.support_levels) == 1
    assert result.support_levels[0].price == Decimal("9.8")


def test_confidence_clamped_into_unit_interval() -> None:
    bad = _good_payload()
    bad["trend"] = {**cast("dict", bad["trend"]), "confidence": 1.7}
    service, _llm, _cache, _kline = _build_service(llm_responses=[json.dumps(bad)])
    result = service.analyze_one("600519")
    assert result.trend.confidence == 1.0
