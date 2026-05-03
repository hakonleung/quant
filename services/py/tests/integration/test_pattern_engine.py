"""Integration tests for DTWPatternEngine + PatternService (modules/04 §8.2)."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

import pyarrow as pa
import pytest
from quant_core.adapters.pattern.dtw_engine import DTWPatternEngine
from quant_core.domain.types.pattern import (
    PatternQuery,
    PatternSeries,
    PatternSourceFromStock,
    PatternSourceUploaded,
)
from quant_core.errors import QuantError
from quant_core.services.pattern_service import PatternService

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

    from quant_core.domain.types.kline import DailyBar


class _FakeKlineRepo:
    """In-memory repo. Stores ``code -> [(trade_date, close_qfq), ...]``."""

    def __init__(self, data: dict[str, list[tuple[date, Decimal]]]) -> None:
        self._data = data

    def upsert_bars(self, code: str, bars: Iterable[DailyBar]) -> None:  # pragma: no cover
        raise NotImplementedError

    def overwrite_bars(self, code: str, bars: Iterable[DailyBar]) -> None:  # pragma: no cover
        raise NotImplementedError

    def get_range(
        self,
        code: str,
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table:
        rows = [(d, c) for d, c in self._data.get(code, []) if start <= d <= end]
        return pa.table(
            {
                "trade_date": [d for d, _ in rows],
                "close_qfq": [c for _, c in rows],
            }
        )

    def get_universe_slice(
        self,
        codes: Sequence[str],
        start: date,
        end: date,
        *,
        columns: Sequence[str] | None = None,
    ) -> pa.Table:
        out_codes: list[str] = []
        out_dates: list[date] = []
        out_closes: list[Decimal] = []
        for code in codes:
            for d, c in self._data.get(code, []):
                if start <= d <= end:
                    out_codes.append(code)
                    out_dates.append(d)
                    out_closes.append(c)
        return pa.table({"code": out_codes, "trade_date": out_dates, "close_qfq": out_closes})

    def get_last_bar(self, code: str) -> DailyBar | None:  # pragma: no cover
        return None

    def last_trade_date(self, code: str) -> date | None:  # pragma: no cover
        return None


def _series(start: date, closes: list[str]) -> list[tuple[date, Decimal]]:
    return [(start + timedelta(days=i), Decimal(c)) for i, c in enumerate(closes)]


def test_top_match_is_the_self_window() -> None:
    """5 stocks x 30 days; reference = stock A's day 0-9 -> A wins top-1."""
    base = date(2026, 1, 1)
    ref_shape = ["10", "11", "12", "11", "13", "14", "13", "15", "16", "17"]
    repo = _FakeKlineRepo(
        {
            "A": _series(base, ref_shape + ["20"] * 20),
            "B": _series(base, ["50"] * 30),
            "C": _series(base, ["100", "90", "80", "70", "60"] * 6),
            "D": _series(base, [str(100 - i) for i in range(30)]),
            "E": _series(base, [str(50 + i % 3) for i in range(30)]),
        }
    )
    engine = DTWPatternEngine(repo)
    query = PatternQuery(
        reference=PatternSeries(
            closes=tuple(Decimal(x) for x in ref_shape),
            source=PatternSourceUploaded(kind="uploaded", filename="ref.csv"),
        ),
        universe=("A", "B", "C", "D", "E"),
        window_days=10,
        asof_end=base + timedelta(days=29),
        lookback_days=30,
        top_n=5,
    )
    matches = engine.find_similar(query)
    assert matches, "expected at least one match"
    top = matches[0]
    assert top.code == "A"
    assert top.start_date == base
    assert top.distance == pytest.approx(0.0, abs=1e-9)


def test_lookahead_reference_rejected() -> None:
    base = date(2026, 1, 1)
    repo = _FakeKlineRepo({"A": _series(base, ["10"] * 30)})
    engine = DTWPatternEngine(repo)
    query = PatternQuery(
        reference=PatternSeries(
            closes=tuple(Decimal("10") for _ in range(10)),
            # Reference inside the scan window — must be rejected.
            source=PatternSourceFromStock(
                kind="from_stock",
                code="A",
                start_date=base + timedelta(days=20),
                end_date=base + timedelta(days=29),
            ),
        ),
        universe=("A",),
        window_days=10,
        asof_end=base + timedelta(days=29),
        lookback_days=30,
        top_n=5,
    )
    with pytest.raises(QuantError) as exc:
        engine.find_similar(query)
    assert exc.value.code == "PATTERN_REFERENCE_LOOKAHEAD"


def test_window_too_short_rejected() -> None:
    base = date(2026, 1, 1)
    repo = _FakeKlineRepo({"A": _series(base, ["10"] * 30)})
    engine = DTWPatternEngine(repo)
    query = PatternQuery(
        reference=PatternSeries(
            closes=tuple(Decimal("10") for _ in range(5)),
            source=PatternSourceUploaded(kind="uploaded", filename="x"),
        ),
        universe=("A",),
        window_days=5,  # below MIN_WINDOW_DAYS
        asof_end=base + timedelta(days=29),
        lookback_days=30,
    )
    with pytest.raises(QuantError) as exc:
        engine.find_similar(query)
    assert exc.value.code == "INVALID_ARGUMENT"


def test_reference_length_must_match_window() -> None:
    base = date(2026, 1, 1)
    repo = _FakeKlineRepo({"A": _series(base, ["10"] * 30)})
    engine = DTWPatternEngine(repo)
    query = PatternQuery(
        reference=PatternSeries(
            closes=tuple(Decimal("10") for _ in range(11)),
            source=PatternSourceUploaded(kind="uploaded", filename="x"),
        ),
        universe=("A",),
        window_days=10,
        asof_end=base + timedelta(days=29),
        lookback_days=30,
    )
    with pytest.raises(QuantError):
        engine.find_similar(query)


def test_empty_universe_returns_empty() -> None:
    repo = _FakeKlineRepo({})
    engine = DTWPatternEngine(repo)
    query = PatternQuery(
        reference=PatternSeries(
            closes=tuple(Decimal("10") for _ in range(10)),
            source=PatternSourceUploaded(kind="uploaded", filename="x"),
        ),
        universe=(),
        window_days=10,
        asof_end=date(2026, 5, 1),
        lookback_days=30,
    )
    assert engine.find_similar(query) == []


def test_pattern_service_reference_from_stock() -> None:
    base = date(2026, 1, 1)
    repo = _FakeKlineRepo({"A": _series(base, ["10", "11", "12", "13"])})
    engine = DTWPatternEngine(repo)
    svc = PatternService(repo, engine)
    series = svc.reference_from_stock("A", base, base + timedelta(days=3))
    assert [str(c) for c in series.closes] == ["10", "11", "12", "13"]
    assert series.source.kind == "from_stock"


def test_pattern_service_reference_missing_raises() -> None:
    repo = _FakeKlineRepo({})
    engine = DTWPatternEngine(repo)
    svc = PatternService(repo, engine)
    with pytest.raises(QuantError) as exc:
        svc.reference_from_stock("A", date(2026, 1, 1), date(2026, 1, 5))
    assert exc.value.code == "KLINE_DATA_MISSING"


def test_pattern_service_reference_inverted_range_raises() -> None:
    repo = _FakeKlineRepo({})
    engine = DTWPatternEngine(repo)
    svc = PatternService(repo, engine)
    with pytest.raises(QuantError) as exc:
        svc.reference_from_stock("A", date(2026, 1, 5), date(2026, 1, 1))
    assert exc.value.code == "INVALID_ARGUMENT"
