"""Unit tests for ``compute_ashare_blacklist`` (`docs/modules/12-blacklist.md`).

Pure-function coverage of every decision branch:
- insufficient kline rows (< 21) → not blacklisted
- one threshold satisfied → not blacklisted
- all three thresholds fail → blacklisted
- ``past_raw`` is None for a window → that window skipped
- only the lowest window evaluable, all fail → blacklisted
- latest close is non-positive → not blacklisted (defensive)

Uses fakes for ``meta_repo`` and ``kline_repo`` so the tests stay
zero-IO (CLAUDE.md §3 — core-asset modules use no real DB).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal

import pyarrow as pa
import pytest

from quant_core.domain.types.stock import StockMeta
from quant_core.services.blacklist_service import compute_ashare_blacklist
from tests._util.clock import FrozenClock


@dataclass(frozen=True, slots=True)
class _Series:
    """One code's `close_qfq` history, latest last."""

    closes: tuple[Decimal | None, ...]


class _FakeMetaRepo:
    """Implements only the ``list_all`` method ``compute_ashare_blacklist`` calls."""

    __slots__ = ("_metas",)

    def __init__(self, codes: Iterable[str]) -> None:
        updated = datetime(2026, 5, 1, tzinfo=UTC)
        self._metas = tuple(
            StockMeta(
                code=code,
                name=f"name-{code}",
                name_pinyin=code.upper(),
                industries="industry",
                list_date=date(2010, 1, 1),
                float_pct=Decimal(1),
                updated_at=updated,
            )
            for code in codes
        )

    def list_all(self) -> list[StockMeta]:
        return list(self._metas)


class _FakeKlineRepo:
    """Implements only ``get_range``; returns a one-column ``close_qfq`` table."""

    __slots__ = ("_by_code",)

    def __init__(self, by_code: dict[str, _Series]) -> None:
        self._by_code = by_code

    def get_range(
        self,
        code: str,
        start: date,
        end: date,  # noqa: ARG002 — matches real signature; not used here
        *,
        columns: Sequence[str] | None = None,  # noqa: ARG002
    ) -> pa.Table:
        series = self._by_code.get(code)
        if series is None:
            return pa.table({"close_qfq": pa.array([], type=pa.string())})
        # Decimal-as-string in real Parquet; pyarrow preserves str | None.
        return pa.table(
            {
                "close_qfq": pa.array(
                    [None if c is None else str(c) for c in series.closes],
                    type=pa.string(),
                ),
            }
        )


def _flat_series(latest: str, *, n: int, base: str = "10") -> _Series:
    """``n``-row series ending in ``latest``, all earlier values = ``base``.

    Useful for stage-return tests: setting `base` and `latest` directly
    controls every window's return ratio (= latest / base - 1).
    """
    fillers: tuple[Decimal | None, ...] = tuple(Decimal(base) for _ in range(n - 1))
    return _Series(closes=(*fillers, Decimal(latest)))


_CLOCK = FrozenClock(datetime(2026, 5, 4, 7, 15, tzinfo=UTC))


@pytest.mark.unit
def test_insufficient_rows_not_blacklisted() -> None:
    repo = _FakeKlineRepo({"600519": _flat_series("11.00", n=20)})  # < 21
    meta = _FakeMetaRepo(["600519"])

    out = compute_ashare_blacklist(meta_repo=meta, kline_repo=repo, clock=_CLOCK)

    assert out.codes == ()
    assert out.universe_size == 1
    assert out.asof == date(2026, 5, 4)


@pytest.mark.unit
def test_one_threshold_passes_not_blacklisted() -> None:
    # 21 rows ⇒ only 20d window evaluable; latest 13.50 vs base 10 = +35 % > 30 %.
    repo = _FakeKlineRepo({"600519": _flat_series("13.50", n=21)})
    meta = _FakeMetaRepo(["600519"])

    out = compute_ashare_blacklist(meta_repo=meta, kline_repo=repo, clock=_CLOCK)

    assert out.codes == ()


@pytest.mark.unit
def test_evaluable_but_no_threshold_met_blacklisted() -> None:
    # 21 rows, latest 11.00 vs base 10 = +10 % — fails the 20d > 30 % gate;
    # 90d / 250d windows are not checkable. checked_any=True, no pass → blacklist.
    repo = _FakeKlineRepo({"600519": _flat_series("11.00", n=21)})
    meta = _FakeMetaRepo(["600519"])

    out = compute_ashare_blacklist(meta_repo=meta, kline_repo=repo, clock=_CLOCK)

    assert out.codes == ("600519",)


@pytest.mark.unit
def test_all_three_windows_evaluated_all_fail_blacklisted() -> None:
    # 251 rows; all flat at 10, latest 11. 20d / 90d / 250d all = +10 %, no
    # threshold passes → blacklist.
    repo = _FakeKlineRepo({"600519": _flat_series("11.00", n=251)})
    meta = _FakeMetaRepo(["600519"])

    out = compute_ashare_blacklist(meta_repo=meta, kline_repo=repo, clock=_CLOCK)

    assert out.codes == ("600519",)


@pytest.mark.unit
def test_long_window_passes_not_blacklisted() -> None:
    # 251 rows; latest = 21 vs base 10 = +110 % > 100 % (250d gate).
    repo = _FakeKlineRepo({"600519": _flat_series("21.00", n=251)})
    meta = _FakeMetaRepo(["600519"])

    out = compute_ashare_blacklist(meta_repo=meta, kline_repo=repo, clock=_CLOCK)

    assert out.codes == ()


@pytest.mark.unit
def test_window_skipped_when_past_close_is_none() -> None:
    # 21 rows; the 20-day-old close is None — window must be skipped.
    # No other window is evaluable, so checked_any stays False → not blacklist.
    closes: list[Decimal | None] = [None, *([Decimal(10)] * 19), Decimal(11)]
    repo = _FakeKlineRepo({"600519": _Series(closes=tuple(closes))})
    meta = _FakeMetaRepo(["600519"])

    out = compute_ashare_blacklist(meta_repo=meta, kline_repo=repo, clock=_CLOCK)

    assert out.codes == ()


@pytest.mark.unit
def test_window_skipped_when_past_close_non_positive() -> None:
    # 21 rows; 20-day-old close is 0 — div-by-zero guard keeps the window
    # in `checked_any` count? No — code only counts the window as
    # `checked_any` AFTER the past>0 check passes. So with 0 there it's
    # skipped without flagging, and we treat as "no evaluable window".
    closes: list[Decimal | None] = [Decimal(0), *([Decimal(10)] * 19), Decimal(11)]
    repo = _FakeKlineRepo({"600519": _Series(closes=tuple(closes))})
    meta = _FakeMetaRepo(["600519"])

    out = compute_ashare_blacklist(meta_repo=meta, kline_repo=repo, clock=_CLOCK)

    assert out.codes == ()


@pytest.mark.unit
def test_latest_close_non_positive_not_blacklisted() -> None:
    # Defensive: latest close = 0 ⇒ stage-return math is undefined; skip.
    closes: tuple[Decimal | None, ...] = (*([Decimal(10)] * 20), Decimal(0))
    repo = _FakeKlineRepo({"600519": _Series(closes=closes)})
    meta = _FakeMetaRepo(["600519"])

    out = compute_ashare_blacklist(meta_repo=meta, kline_repo=repo, clock=_CLOCK)

    assert out.codes == ()


@pytest.mark.unit
def test_latest_close_none_not_blacklisted() -> None:
    closes: tuple[Decimal | None, ...] = (*([Decimal(10)] * 20), None)
    repo = _FakeKlineRepo({"600519": _Series(closes=closes)})
    meta = _FakeMetaRepo(["600519"])

    out = compute_ashare_blacklist(meta_repo=meta, kline_repo=repo, clock=_CLOCK)

    assert out.codes == ()


@pytest.mark.unit
def test_result_codes_sorted_and_universe_size_correct() -> None:
    repo = _FakeKlineRepo(
        {
            "600519": _flat_series("11.00", n=21),  # blacklist (10 % vs 30)
            "300750": _flat_series("11.00", n=21),  # blacklist
            "000001": _flat_series("13.50", n=21),  # passes 20d gate
        }
    )
    meta = _FakeMetaRepo(["600519", "300750", "000001"])

    out = compute_ashare_blacklist(meta_repo=meta, kline_repo=repo, clock=_CLOCK)

    assert out.codes == ("300750", "600519")
    assert out.universe_size == 3
    assert out.asof == date(2026, 5, 4)
