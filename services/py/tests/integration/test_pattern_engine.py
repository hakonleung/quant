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
    """5 stocks x 30 days; reference shape sits at the start of A — A wins top-1."""
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
        recent_trading_days=30,
        top_n=5,
    )
    matches = engine.find_similar(query)
    assert matches, "expected at least one match"
    top = matches[0]
    assert top.code == "A"
    assert top.start_date == base
    # Identical shape AND identical period return → both terms are zero.
    assert top.distance == pytest.approx(0.0, abs=1e-9)
    assert top.similarity == pytest.approx(0.0, abs=1e-9)
    # Reference rises 10 -> 17, candidate rises 10 -> 17 → return = 0.7
    assert top.period_return == pytest.approx(0.7, abs=1e-6)


def test_period_return_penalty_breaks_shape_tie() -> None:
    """Two candidates with the same z-scored shape but different period
    returns: the one whose return is closer to the reference wins."""
    base = date(2026, 1, 1)
    # Reference: linear up, +90% over 10 bars.
    ref_shape = [str(10 + i) for i in range(10)]  # 10..19
    # B's window: same linear-up shape, also +90% — identical pattern.
    # C's window: same z-scored shape (linear-up) but only +10% — pattern matches, return diverges.
    repo = _FakeKlineRepo(
        {
            "B": _series(base, ref_shape + ["100"] * 20),
            "C": _series(base, [f"{100 + i:.4f}" for i in range(10)] + ["200"] * 20),
        }
    )
    engine = DTWPatternEngine(repo)
    query = PatternQuery(
        reference=PatternSeries(
            closes=tuple(Decimal(x) for x in ref_shape),
            source=PatternSourceUploaded(kind="uploaded", filename="ref.csv"),
        ),
        universe=("B", "C"),
        window_days=10,
        asof_end=base + timedelta(days=29),
        recent_trading_days=30,
        top_n=5,
    )
    matches = engine.find_similar(query)
    # Both should match; B (matching return) ranks ahead of C.
    by_code = {m.code: m for m in matches}
    assert "B" in by_code and "C" in by_code
    assert by_code["B"].similarity < by_code["C"].similarity


def test_only_recent_tail_is_scanned() -> None:
    """The shape sits in the FIRST 10 days of A's history; with a 12-day tail
    those bars are out of scope and A produces no match."""
    base = date(2026, 1, 1)
    ref_shape = ["10", "11", "12", "11", "13", "14", "13", "15", "16", "17"]
    # 10 days of ref shape + 50 flat days of "20" = 60 calendar days.
    repo = _FakeKlineRepo({"A": _series(base, ref_shape + ["20"] * 50)})
    engine = DTWPatternEngine(repo)
    query = PatternQuery(
        reference=PatternSeries(
            closes=tuple(Decimal(x) for x in ref_shape),
            source=PatternSourceUploaded(kind="uploaded", filename="ref.csv"),
        ),
        universe=("A",),
        window_days=10,
        asof_end=base + timedelta(days=59),
        recent_trading_days=12,  # last 12 trading days are all "20"
        top_n=5,
    )
    matches = engine.find_similar(query)
    # 12-bar tail produces 3 windows, all on the flat "20" segment with
    # ratio=1 (passes the loose ratio filter); but they're all flat so
    # distance > 0. The point is: they don't include the actual ref shape.
    for m in matches:
        # No match should overlap the original ref-shape bars [day 0, day 9].
        assert m.start_date >= base + timedelta(days=10)


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
        recent_trading_days=30,
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
        recent_trading_days=30,
    )
    with pytest.raises(QuantError):
        engine.find_similar(query)


def test_recent_tail_must_be_at_least_window_days() -> None:
    base = date(2026, 1, 1)
    repo = _FakeKlineRepo({"A": _series(base, ["10"] * 30)})
    engine = DTWPatternEngine(repo)
    query = PatternQuery(
        reference=PatternSeries(
            closes=tuple(Decimal("10") for _ in range(10)),
            source=PatternSourceUploaded(kind="uploaded", filename="x"),
        ),
        universe=("A",),
        window_days=10,
        asof_end=base + timedelta(days=29),
        recent_trading_days=9,
    )
    with pytest.raises(QuantError) as exc:
        engine.find_similar(query)
    assert exc.value.code == "INVALID_ARGUMENT"


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
        recent_trading_days=30,
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
