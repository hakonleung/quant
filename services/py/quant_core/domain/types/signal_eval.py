"""Types for screen-signal evaluation (docs/modules to be added).

Inputs:
    - :class:`SignalInput`     — one (signal_date, code) pair selected by
      a screen at the end of trading day ``signal_date``.
    - :class:`Bar`             — one forward-adjusted open price per
      trading day, per code.

Outputs:
    - :class:`Observation`     — one realised (signal_date, code,
      holding) → return tuple. Entry is the **next** trading day after
      ``signal_date`` to avoid look-ahead bias; exit is ``holding``
      trading days after entry.
    - :class:`HoldingSummary`  — per-holding distribution stats over the
      full observation set.
    - :class:`SignalEvalResult`— bundles both for the Flight op payload.

All types are immutable. Prices use ``Decimal`` at the boundary; the
return ``ret`` is dimensionless and stored as ``float`` because every
downstream stat (mean / quantile / std) is a float anyway.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from datetime import date
    from decimal import Decimal


@dataclass(frozen=True, slots=True)
class SignalInput:
    """One (signal_date, code) pair selected by a screen."""

    signal_date: date
    code: str


@dataclass(frozen=True, slots=True)
class Bar:
    """One trading-day open price for a single code.

    ``trade_date`` is the calendar date of the bar; ``open_qfq`` is the
    forward-adjusted open used for both entry and exit prices.
    """

    trade_date: date
    open_qfq: Decimal


@dataclass(frozen=True, slots=True)
class Observation:
    """A realised return for a (signal, holding) pair.

    ``baseline_mean`` and ``excess_ret`` are populated only when the
    caller supplied a baseline series for ``(signal_date, holding)``.
    Both are ``None`` when no baseline was available.
    """

    signal_date: date
    code: str
    holding: int
    entry_date: date
    entry_px: Decimal
    exit_date: date
    exit_px: Decimal
    ret: float
    baseline_mean: float | None
    excess_ret: float | None


@dataclass(frozen=True, slots=True)
class HoldingSummary:
    """Distribution stats for every observation at one ``holding``."""

    holding: int
    n: int
    mean: float
    median: float
    std: float
    p05: float
    p25: float
    p75: float
    p95: float
    win_rate: float
    sharpe_like: float


@dataclass(frozen=True, slots=True)
class BaselineSummary:
    """Aggregate of the universe-mean series at one holding.

    See ``packages/shared/src/types/backtest.ts`` for the口径.
    """

    holding: int
    n: int
    universe_mean: float
    universe_std: float


@dataclass(frozen=True, slots=True)
class SpreadSummary:
    """Selection-effect t-stat at one holding.

    ``spread`` for date T = ``mean(signal_returns@T) - universe_mean(T)``.
    Reported stats aggregate that per-date series.
    """

    holding: int
    n: int
    spread_mean: float
    spread_std: float
    spread_t_stat: float
    win_rate: float


@dataclass(frozen=True, slots=True)
class SignalEvalResult:
    """Bundled output of :func:`evaluate_signal`.

    Attributes:
        observations: All realised (signal_date, code, holding) tuples
            that had enough forward data. Ordered by (signal_date, code,
            holding).
        summary: One row per holding, in the same order as ``holdings``.
        holdings: The requested holding periods (de-duplicated, sorted).
        signal_date_range: ``(min, max)`` over input signal dates; ``None``
            when no signals were supplied.
        universe_size_avg: Average number of signals per ``signal_date``
            in the input (i.e. how many codes the screen picks on a
            typical day). 0.0 when no signals.
    """

    observations: tuple[Observation, ...]
    summary: tuple[HoldingSummary, ...]
    holdings: tuple[int, ...]
    signal_date_range: tuple[date, date] | None
    universe_size_avg: float
    baseline_summary: tuple[BaselineSummary, ...] | None
    spread_summary: tuple[SpreadSummary, ...] | None
