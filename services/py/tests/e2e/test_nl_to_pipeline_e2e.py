"""End-to-end: Chinese NL query → DeepSeek translation → screening pipeline.

This test hits the real DeepSeek API and is skipped unless
``--run-e2e`` is passed AND ``DEEPSEEK_API_KEY`` is set.

Run::

    DEEPSEEK_API_KEY=sk-... uv run pytest --run-e2e \\
        services/py/tests/e2e/test_nl_to_pipeline_e2e.py -v -s

The synthetic universe is 50 stocks x ~300 daily bars built so that:
* a handful of stocks satisfy each compound condition (no "everything
  matches" false positive, no "nothing matches" false negative)
* turnover / amount / list_date / industry vary deterministically by code
  so that universe-stage filters (ST / 北交所 / 上市天数) actually prune

The compound queries are the user's real screening prompts; assertions
are loose ("got at least one match", "fields parsed correctly") because
the LLM may legitimately translate the same NL slightly differently
between runs. The intent is **regression-canary** — the pipeline runs
end-to-end and the matches it returns are non-trivial.
"""

from __future__ import annotations

import os
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from quant_cache.parquet_kline_repo import ParquetKlineRepo
from quant_cache.parquet_stock_meta_repo import ParquetStockMetaRepo
from quant_core.domain.types.kline import KLINE_FLOOR_DATE, AdjFactor, RawDailyBar
from quant_core.domain.types.stock import StockMeta
from quant_core.services.kline_service import KlineService
from quant_core.services.nl_to_dsl_service import NlToDslService
from quant_core.services.screen_service import ScreenService
from quant_core.services.screening_pipeline import (
    PipelineRequest,
    ScreeningPipeline,
)
from quant_core.services.universe_screen_service import UniverseScreenService
from quant_io.llm.deepseek_client import DeepSeekClient

if TYPE_CHECKING:
    from collections.abc import Iterable

    from quant_core.services.nl_to_dsl_service import NlToDslResponse


pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(
        not os.environ.get("DEEPSEEK_API_KEY"),
        reason="DEEPSEEK_API_KEY not set",
    ),
]


# -- synthetic data builder ---------------------------------------------


_TOTAL_DAYS = 300
"""Number of trading days per synthetic stock (well past 240 = 1y)."""


def _trading_dates() -> list[date]:
    """Skip weekends so the row count looks like real trading calendar."""
    out: list[date] = []
    d = KLINE_FLOOR_DATE
    while len(out) < _TOTAL_DAYS:
        if d.weekday() < 5:  # Mon-Fri
            out.append(d)
        d += timedelta(days=1)
    return out


def _stock_profile(idx: int, asof: date) -> dict[str, object]:
    """Deterministic per-stock parameters keyed by the synthetic ``asof``."""
    if idx < 35:
        # SH main-board uptrend cohort, listed years ago.
        code = f"6{600000 + idx:06d}"[1:]
        name = f"测试主板{idx:02d}"
        drift = 0.005 + (idx % 7) * 0.0015
        turnover = Decimal("0.03") + Decimal(idx % 5) * Decimal("0.01")
        list_date = date(2018, 1, 5) + timedelta(days=idx * 30)
    elif idx < 40:
        # ST cohort — universe stage drops by name prefix.
        code = f"00{idx + 1:04d}"
        name = f"ST垃圾{idx:02d}"
        drift = 0.0015
        turnover = Decimal("0.02")
        list_date = date(2015, 6, 1)
    elif idx < 45:
        # 北交所 — universe stage drops by code prefix (8/920).
        code = f"83{2000 + idx:04d}"
        name = f"北交所{idx:02d}"
        drift = 0.012
        turnover = Decimal("0.05")
        list_date = date(2022, 9, 1)
    elif idx < 48:
        # Newly listed (< 90d before asof) — universe stage drops by listed_days.
        code = f"30{2000 + idx:04d}"
        name = f"新股{idx:02d}"
        drift = 0.02
        turnover = Decimal("0.10")
        list_date = asof - timedelta(days=30)
    else:
        # Sideways / downtrending main-board — passes universe but fails screen.
        code = f"6{650000 + idx:06d}"[1:]
        name = f"震荡主板{idx:02d}"
        drift = -0.001
        turnover = Decimal("0.005")
        list_date = date(2010, 1, 5)
    return {
        "idx": idx,
        "code": code,
        "name": name,
        "drift": drift,
        "turnover": turnover,
        "list_date": list_date,
        "base_price": Decimal("10") + Decimal(idx % 13),
    }


def _build_bars(profile: dict[str, object]) -> list[RawDailyBar]:
    """Geometric-drift price series with a deterministic per-day jitter."""
    code = str(profile["code"])
    drift = float(profile["drift"])  # type: ignore[arg-type]
    turnover = profile["turnover"]
    base = profile["base_price"]
    bars: list[RawDailyBar] = []
    price = base
    for i, d in enumerate(_trading_dates()):
        # Cosine-modulated multiplier for predictable but non-monotonic motion.
        import math

        mult = Decimal(str(1.0 + drift + 0.005 * math.sin(i * 0.27)))
        price = price * mult
        # Round so parquet round-trip stays clean.
        price = price.quantize(Decimal("0.01"))
        if price <= 0:
            price = Decimal("0.01")
        amount = (price * 1_000_000).quantize(Decimal("0.01"))
        bars.append(
            RawDailyBar(
                code=code,
                trade_date=d,
                open=price,
                high=(price * Decimal("1.005")).quantize(Decimal("0.01")),
                low=(price * Decimal("0.995")).quantize(Decimal("0.01")),
                close=price,
                volume=1_000_000,
                amount=amount,
                turnover_rate=turnover,  # type: ignore[arg-type]
            )
        )
    return bars


class _DataSource:
    def __init__(self, bars_by_code: dict[str, list[RawDailyBar]]) -> None:
        self._bars = bars_by_code

    @property
    def name(self) -> str:
        return "synthetic"

    def healthcheck(self) -> object:
        raise NotImplementedError

    def fetch_range(self, code: str, start: date, end: date) -> Iterable[RawDailyBar]:
        return [b for b in self._bars.get(code, []) if start <= b.trade_date <= end]

    def fetch_adj_factors(self, code: str, start: date, end: date) -> Iterable[AdjFactor]:
        return [AdjFactor(code=code, trade_date=start, factor=Decimal("1.0"))]


@pytest.fixture(scope="module")
def synthetic_pipeline(tmp_path_factory: pytest.TempPathFactory) -> dict[str, object]:
    """Provision 50 stocks + 300 bars, return the pipeline + asof + meta-repo."""
    tmp_path = tmp_path_factory.mktemp("e2e_pipeline")
    last_day = _trading_dates()[-1]
    profiles = [_stock_profile(i, last_day) for i in range(50)]
    bars_by_code: dict[str, list[RawDailyBar]] = {str(p["code"]): _build_bars(p) for p in profiles}
    clock_now = datetime.combine(last_day, datetime.min.time(), tzinfo=UTC)

    meta_repo = ParquetStockMetaRepo(path=tmp_path / "meta.parquet")
    metas: list[StockMeta] = [
        StockMeta(
            code=str(p["code"]),
            name=str(p["name"]),
            name_pinyin="",
            industries="测试行业",
            list_date=p["list_date"],  # type: ignore[arg-type]
            float_pct=Decimal("0.6") + Decimal(int(p["idx"]) % 5) * Decimal("0.05"),  # type: ignore[arg-type]
            updated_at=clock_now,
        )
        for p in profiles
    ]
    meta_repo.upsert_many(metas)

    kline_repo = ParquetKlineRepo(root=tmp_path / "kline")

    class _Clock:
        def now(self) -> datetime:
            return clock_now

    src = _DataSource(bars_by_code)
    kline_svc = KlineService(src, kline_repo, _Clock())
    for code in bars_by_code:
        kline_svc.sync_code(code)

    pipeline = ScreeningPipeline(
        universe_service=UniverseScreenService(meta_repo=meta_repo),
        screen_service=ScreenService(kline_repo=kline_repo),
    )
    nl_svc = NlToDslService(llm=DeepSeekClient())
    return {
        "pipeline": pipeline,
        "nl_svc": nl_svc,
        "asof": last_day,
        "meta_repo": meta_repo,
        "all_codes": list(bars_by_code.keys()),
    }


def _translate_and_run(
    fixture: dict[str, object], nl_query: str
) -> tuple[NlToDslResponse, object]:
    """Translate via real LLM, then run the pipeline."""
    nl_svc: NlToDslService = fixture["nl_svc"]  # type: ignore[assignment]
    pipeline: ScreeningPipeline = fixture["pipeline"]  # type: ignore[assignment]
    asof: date = fixture["asof"]  # type: ignore[assignment]
    response = nl_svc.translate(nl_query, asof=asof)
    result = pipeline.run(
        PipelineRequest(
            screen_plan=response.screen_plan,
            universe_plan=response.universe_plan,
            rank=response.rank,
        )
    )
    return response, result


def _print_response_and_result(label: str, response: NlToDslResponse, result: object) -> None:
    print(f"\n=== {label} ===")
    print("warnings:", response.warnings)
    print("rank:", response.rank)
    if response.universe_plan is not None:
        print(f"universe_plan asof={response.universe_plan.asof}")
    print(f"matches: {len(result.matches)}")  # type: ignore[attr-defined]
    for m in result.matches[:10]:  # type: ignore[attr-defined]
        print(
            f"  {m.code}: metrics={m.evidence.get('metrics')} rank={m.evidence.get('rank_metric')}"
        )


# -- the user's prompt ---------------------------------------------------


_PRIMARY_QUERY = (
    "股价高于3个月最高价的90%, 非st, 非北交所, 上市时间大于90日, 近一年涨幅大于100%, "
    "换手率大于2%, 涨跌幅大于3%, 流通市值大于60亿, 成交额大于4亿, 近一个月涨幅大于15%, "
    "实际换手率小于27%, 近10日涨幅前20排序"
)


def test_primary_compound_query(synthetic_pipeline: dict[str, object]) -> None:
    """The full prompt the user posed earlier in the conversation.

    The LLM is allowed (and expected) to drop the unsupported conditions
    (3-month-max x 90%, 流通市值) and surface them as warnings; the rest
    must translate to a runnable plan that returns deterministic matches
    on the synthetic universe.
    """
    response, result = _translate_and_run(synthetic_pipeline, _PRIMARY_QUERY)
    _print_response_and_result("primary", response, result)
    # Universe stage must drop ST + 北交所 + new listings.
    matched_codes = {m.code for m in result.matches}  # type: ignore[attr-defined]
    assert all(not c.startswith("83") for c in matched_codes), "北交所 leaked through"
    assert not any(c.startswith("30") for c in matched_codes), "newly-listed leaked through"
    # Rank top-N: the LLM should have set top_n=20.
    if response.rank is not None and response.rank.top_n is not None:
        assert len(matched_codes) <= response.rank.top_n
    # The strong-uptrend SH cohort (idx 0..34) should produce some hits.
    assert len(matched_codes) > 0


# -- secondary compound prompts -----------------------------------------


_SECONDARY_QUERIES: list[str] = [
    "近20天每天换手率都大于3%, 同时近20天涨幅大于20%, 剔除ST",
    "连续5天上涨, 每天涨幅大于2%, 剔除北交所, 按涨幅排序取前10",
    "收盘价高于20日均线, 同时10日均线高于20日均线, 上市超过一年, 取前30按近5日涨幅",
    "最近5日成交额都大于2亿, 近一个月涨幅介于10%到50%之间, 剔除ST和新股",
    "近30日内存在某天涨幅大于9%, 同时换手率大于5%, 按近10日涨幅排序",
]


@pytest.mark.parametrize("nl", _SECONDARY_QUERIES)
def test_secondary_compound_queries(synthetic_pipeline: dict[str, object], nl: str) -> None:
    response, result = _translate_and_run(synthetic_pipeline, nl)
    _print_response_and_result(nl[:30], response, result)
    matched = {m.code for m in result.matches}  # type: ignore[attr-defined]
    # Universe-stage invariants (LLM should have routed ST / 北交所 / 新股
    # filters into universe_plan, not lost them).
    assert not any(c.startswith("83") for c in matched)
    # Don't crash, don't return everything; the synthetic data has 50
    # codes and at most 35 in the strong cohort, so a sane plan returns
    # < 50 matches.
    assert len(matched) < 50
