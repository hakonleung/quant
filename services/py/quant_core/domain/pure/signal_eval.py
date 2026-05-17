"""Pure signal-evaluation engine (event-study style, not portfolio).

For every (signal_date, code) the screen emitted, look forward
``holding`` **trading days** and record the return between the next
trading day's open and the exit-day's open. No portfolio, no rebalance,
no cost model — the same code can appear on N consecutive days and
each shows up as N independent observations. That maximises sample
count on a short (≈ 250d) window, which is the whole point of
event-study evaluation in this codebase.

Inputs land here already parsed (the Flight op handles JSON / date
parsing). The function is pure: no IO, no clock, no logging, no global
state. Deterministic for any fixed input.
"""

from __future__ import annotations

import math
import statistics
from typing import TYPE_CHECKING

from quant_core.domain.types.signal_eval import (
    BaselineSummary,
    HoldingSummary,
    Observation,
    SignalEvalResult,
    SignalInput,
    SpreadSummary,
)
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence
    from datetime import date as date_cls

    from quant_core.domain.types.signal_eval import Bar


def evaluate_signal(
    signals: Sequence[SignalInput],
    bars_by_code: Mapping[str, Sequence[Bar]],
    holdings: Sequence[int],
    *,
    baselines: Mapping[int, Mapping[date_cls, tuple[float, float]]] | None = None,
) -> SignalEvalResult:
    """Compute per-holding return observations + summary.

    Args:
        signals: One entry per (signal_date, code) the screen emitted.
            Duplicates are allowed (a code repeating across signal dates
            is the normal case for a stable screen).
        bars_by_code: For each ``code``, the bars covering the evaluation
            window. Bars must be sorted ascending by ``trade_date`` and
            contain **only trading days** (the holding count is in
            trading days). Codes referenced by signals but missing from
            this map yield zero observations.
        holdings: Holding periods in trading days, e.g. ``[5, 10, 20,
            60, 90]``. Must be all positive; duplicates de-duplicated;
            output ``summary`` is sorted ascending by holding.

    Returns:
        :class:`SignalEvalResult`. Observations whose ``signal_date``
        has no future bar (entry impossible) or whose exit index falls
        past the last bar (window truncated) are silently dropped — they
        are unrealised, not failures.

    Raises:
        QuantError: ``INVALID_ARGUMENT`` for empty ``holdings``,
            non-positive holding values, or bars not sorted ascending.
    """
    unique_holdings = _validate_holdings(holdings)

    indexed = {code: _build_index(code, bars) for code, bars in bars_by_code.items()}

    observations: list[Observation] = []
    for sig in signals:
        observations.extend(_observations_for_signal(sig, indexed, unique_holdings, baselines))
    observations.sort(key=lambda o: (o.signal_date, o.code, o.holding))

    summary = tuple(
        _summarise(h, [o.ret for o in observations if o.holding == h]) for h in unique_holdings
    )
    baseline_summary = (
        tuple(_summarise_baseline(h, baselines[h]) for h in unique_holdings if h in baselines)
        if baselines is not None
        else None
    )
    spread_summary = (
        tuple(_summarise_spread(h, observations) for h in unique_holdings)
        if baselines is not None
        else None
    )
    return SignalEvalResult(
        observations=tuple(observations),
        summary=summary,
        holdings=unique_holdings,
        signal_date_range=_date_range(signals),
        universe_size_avg=_universe_avg(signals),
        baseline_summary=baseline_summary,
        spread_summary=spread_summary,
    )


def _validate_holdings(holdings: Sequence[int]) -> tuple[int, ...]:
    if not holdings:
        raise QuantError("INVALID_ARGUMENT", "holdings must be non-empty")
    for h in holdings:
        if h <= 0:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"holdings must be positive trading-day counts; got {h}",
                {"holding": h},
            )
    return tuple(sorted(set(holdings)))


def _observations_for_signal(
    sig: SignalInput,
    indexed: Mapping[str, _CodeIndex],
    unique_holdings: tuple[int, ...],
    baselines: Mapping[int, Mapping[date_cls, tuple[float, float]]] | None,
) -> list[Observation]:
    idx = indexed.get(sig.code)
    if idx is None or not idx.bars:
        return []
    entry_pos = idx.first_after(sig.signal_date)
    if entry_pos is None:
        return []
    entry_bar = idx.bars[entry_pos]
    if entry_bar.open_qfq <= 0:
        return []
    out: list[Observation] = []
    for h in unique_holdings:
        exit_pos = entry_pos + h
        if exit_pos >= len(idx.bars):
            continue
        exit_bar = idx.bars[exit_pos]
        if exit_bar.open_qfq <= 0:
            continue
        ret = float(exit_bar.open_qfq) / float(entry_bar.open_qfq) - 1.0
        # Baseline is keyed by entry_bar.trade_date — the actual trading
        # day from which the universe forward-return is measured. NestJS
        # computes it as mean(open(E+h)/open(E) - 1) over all codes for
        # each trading day E.
        baseline_mean = _baseline_at(baselines, h, entry_bar.trade_date)
        excess = ret - baseline_mean if baseline_mean is not None else None
        out.append(
            Observation(
                signal_date=sig.signal_date,
                code=sig.code,
                holding=h,
                entry_date=entry_bar.trade_date,
                entry_px=entry_bar.open_qfq,
                exit_date=exit_bar.trade_date,
                exit_px=exit_bar.open_qfq,
                ret=ret,
                baseline_mean=baseline_mean,
                excess_ret=excess,
            )
        )
    return out


def _baseline_at(
    baselines: Mapping[int, Mapping[date_cls, tuple[float, float]]] | None,
    holding: int,
    signal_date: date_cls,
) -> float | None:
    if baselines is None:
        return None
    series = baselines.get(holding)
    if series is None:
        return None
    pair = series.get(signal_date)
    if pair is None:
        return None
    return pair[0]


def _summarise_baseline(
    holding: int, series: Mapping[date_cls, tuple[float, float]]
) -> BaselineSummary:
    means = [m for (m, _s) in series.values()]
    n = len(means)
    if n == 0:
        return BaselineSummary(holding=holding, n=0, universe_mean=0.0, universe_std=0.0)
    mean = statistics.fmean(means)
    std = statistics.pstdev(means) if n > 1 else 0.0
    return BaselineSummary(holding=holding, n=n, universe_mean=mean, universe_std=std)


def _summarise_spread(holding: int, observations: list[Observation]) -> SpreadSummary:
    # Group this-holding observations by signal_date, then compute the
    # per-date spread = mean(signal_returns@T) - universe_mean@T.
    by_date: dict[date_cls, list[Observation]] = {}
    for o in observations:
        if o.holding != holding or o.baseline_mean is None:
            continue
        by_date.setdefault(o.signal_date, []).append(o)
    spreads: list[float] = []
    wins = 0
    for group in by_date.values():
        signal_mean = statistics.fmean(o.ret for o in group)
        baseline_mean = group[0].baseline_mean
        if baseline_mean is None:  # pragma: no cover — filtered above
            continue
        spread = signal_mean - baseline_mean
        spreads.append(spread)
        if spread > 0.0:
            wins += 1
    n = len(spreads)
    if n == 0:
        return SpreadSummary(
            holding=holding,
            n=0,
            spread_mean=0.0,
            spread_std=0.0,
            spread_t_stat=0.0,
            win_rate=0.0,
        )
    mean = statistics.fmean(spreads)
    std = statistics.pstdev(spreads) if n > 1 else 0.0
    t_stat = mean / (std / math.sqrt(n)) if std > 0.0 and n > 1 else 0.0
    if math.isnan(t_stat) or math.isinf(t_stat):
        t_stat = 0.0
    return SpreadSummary(
        holding=holding,
        n=n,
        spread_mean=mean,
        spread_std=std,
        spread_t_stat=t_stat,
        win_rate=wins / n,
    )


def _date_range(signals: Sequence[SignalInput]) -> tuple[date_cls, date_cls] | None:
    if not signals:
        return None
    dates = [s.signal_date for s in signals]
    return (min(dates), max(dates))


def _universe_avg(signals: Sequence[SignalInput]) -> float:
    if not signals:
        return 0.0
    per_day: dict[date_cls, int] = {}
    for s in signals:
        per_day[s.signal_date] = per_day.get(s.signal_date, 0) + 1
    return sum(per_day.values()) / len(per_day)


# -- helpers ---------------------------------------------------------------


class _CodeIndex:
    """Per-code bar lookup with monotonic trade_date ordering."""

    __slots__ = ("bars",)

    def __init__(self, bars: tuple[Bar, ...]) -> None:
        self.bars = bars

    def first_after(self, signal_date: date_cls) -> int | None:
        """Return the position of the first bar with ``trade_date >
        signal_date``, or ``None`` when no such bar exists.

        Linear scan is fine: bars are O(window length) ≤ ~300, and the
        Python overhead of bisect on tuple-of-dataclasses is comparable.
        """
        for i, bar in enumerate(self.bars):
            if bar.trade_date > signal_date:
                return i
        return None


def _build_index(code: str, bars: Sequence[Bar]) -> _CodeIndex:
    materialised = tuple(bars)
    for i in range(1, len(materialised)):
        if materialised[i].trade_date <= materialised[i - 1].trade_date:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"bars for {code!r} must be strictly ascending by trade_date",
                {"code": code, "index": i},
            )
    return _CodeIndex(materialised)


def _summarise(holding: int, rets: list[float]) -> HoldingSummary:
    n = len(rets)
    if n == 0:
        return HoldingSummary(
            holding=holding,
            n=0,
            mean=0.0,
            median=0.0,
            std=0.0,
            p05=0.0,
            p25=0.0,
            p75=0.0,
            p95=0.0,
            win_rate=0.0,
            sharpe_like=0.0,
        )
    mean = statistics.fmean(rets)
    median = statistics.median(rets)
    std = statistics.pstdev(rets) if n > 1 else 0.0
    sorted_rets = sorted(rets)
    p05 = _quantile(sorted_rets, 0.05)
    p25 = _quantile(sorted_rets, 0.25)
    p75 = _quantile(sorted_rets, 0.75)
    p95 = _quantile(sorted_rets, 0.95)
    wins = sum(1 for r in rets if r > 0.0)
    win_rate = wins / n
    sharpe_like = mean / std if std > 0.0 else 0.0
    # NaN/inf guard: degenerate inputs (e.g. all-equal rets) can yield
    # 0/0 in sharpe_like; statistics handled std=0 already, but be
    # defensive against caller-supplied inf prices.
    if math.isnan(sharpe_like) or math.isinf(sharpe_like):
        sharpe_like = 0.0
    return HoldingSummary(
        holding=holding,
        n=n,
        mean=mean,
        median=median,
        std=std,
        p05=p05,
        p25=p25,
        p75=p75,
        p95=p95,
        win_rate=win_rate,
        sharpe_like=sharpe_like,
    )


def _quantile(sorted_values: list[float], q: float) -> float:
    """Linear-interpolation quantile on a pre-sorted sequence.

    Matches numpy's default (``method='linear'``); kept inline to avoid
    pulling numpy into the pure module.
    """
    n = len(sorted_values)
    if n == 1:
        return sorted_values[0]
    pos = q * (n - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return sorted_values[lo]
    frac = pos - lo
    return sorted_values[lo] * (1.0 - frac) + sorted_values[hi] * frac
