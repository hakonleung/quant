"""DTW-based :class:`PatternEngine` implementation (modules/04 §3, §4).

Searches the **most recent** ``recent_trading_days`` trading bars per
candidate code and slides a ``window_days``-length window through
them, scoring each window against the z-scored reference using DTW
with a Sakoe-Chiba band.

Cheap pre-filter: candidate windows whose first/last close ratio
differs from the reference's ratio by more than a configurable factor
are skipped before the DTW step (doc §4 "v1 优化"). Tuned
conservatively (factor 3.0) so it never drops a true match — only the
obvious non-fits.

Layered location: the doc proposes a top-level ``quant_compute``
package; M4 keeps it inside ``quant_core/adapters/`` to avoid a new
wheel target. The port stays in ``quant_core/ports``, so the move is a
pure rename when ``quant_compute`` is split out.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from typing import TYPE_CHECKING, Final

from quant_core.domain.pure.pattern import dtw_distance, z_score
from quant_core.domain.types.pattern import PatternMatch
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from datetime import date as date_cls
    from decimal import Decimal

    from quant_core.domain.types.pattern import PatternQuery
    from quant_core.ports.kline_repo import KlineRepo


_DEFAULT_BAND: Final[int] = 5
_DEFAULT_RATIO_TOLERANCE: Final[float] = 3.0
_MIN_WINDOW_DAYS: Final[int] = 10
# How heavily a 1-unit (=100pp) deviation in period return weighs into
# the combined similarity score relative to the DTW shape distance.
# 10 means a 10pp gap in cumulative move adds ~1 unit to similarity,
# roughly balanced against typical DTW distances on 10-bar windows.
_RETURN_DEVIATION_WEIGHT: Final[float] = 10.0


class DTWPatternEngine:
    """Brute-force DTW scan over a candidate universe.

    Args:
        repo: K-line repo used to fetch ``close_qfq`` series.
        band: Sakoe-Chiba radius. ``None`` removes the constraint.
        ratio_tolerance: First-vs-last close ratio is compared against
            the reference's; candidates outside ``[1/k, k]`` of the
            reference ratio are skipped before DTW. Set to ``math.inf``
            to disable.
    """

    __slots__ = ("_band", "_ratio_tolerance", "_repo")

    def __init__(
        self,
        repo: KlineRepo,
        *,
        band: int | None = _DEFAULT_BAND,
        ratio_tolerance: float = _DEFAULT_RATIO_TOLERANCE,
    ) -> None:
        self._repo = repo
        self._band = band
        self._ratio_tolerance = ratio_tolerance

    def find_similar(self, query: PatternQuery) -> list[PatternMatch]:
        _validate_query(query)
        ref = z_score(query.reference.closes)
        ref_ratio = _safe_ratio(ref[-1], ref[0])
        ref_period_return = _period_return(
            float(query.reference.closes[0]),
            float(query.reference.closes[-1]),
        )

        if not query.universe:
            return []

        # Fetch a calendar range wide enough to safely contain
        # ``recent_trading_days`` trading bars per code (allow for
        # weekends + the occasional suspension).
        end = query.asof_end
        fetch_start = end - timedelta(days=query.recent_trading_days * 2 + 14)
        table = self._repo.get_universe_slice(
            query.universe,
            fetch_start,
            end,
            columns=["code", "trade_date", "close_qfq"],
        )

        per_code = _group_by_code(table)
        matches: list[PatternMatch] = []
        for code, rows in per_code.items():
            matches.extend(
                self._scan_one_code(
                    code,
                    rows,
                    ref,
                    ref_ratio,
                    ref_period_return,
                    query.window_days,
                    query.recent_trading_days,
                )
            )
        matches.sort(key=lambda m: m.similarity)
        return matches[: query.top_n]

    def _scan_one_code(
        self,
        code: str,
        rows: list[tuple[date_cls, Decimal | None]],
        ref: list[float],
        ref_ratio: float,
        ref_period_return: float,
        window_days: int,
        recent_trading_days: int,
    ) -> list[PatternMatch]:
        # Drop rows where qfq close is missing (suspended day before
        # baseline factor), then keep only the most recent trading bars
        # per the requested tail length.
        clean: list[tuple[date_cls, Decimal]] = [(d, c) for d, c in rows if c is not None]
        if len(clean) > recent_trading_days:
            clean = clean[-recent_trading_days:]
        if len(clean) < window_days:
            return []
        out: list[PatternMatch] = []
        for i in range(len(clean) - window_days + 1):
            win = clean[i : i + window_days]
            closes = [c for _, c in win]
            first = float(closes[0])
            last = float(closes[-1])
            cand_ratio = _safe_ratio(last, first)
            if not _ratio_within(ref_ratio, cand_ratio, self._ratio_tolerance):
                continue
            cand = z_score(closes)
            d = dtw_distance(cand, ref, window=self._band)
            cand_period_return = _period_return(first, last)
            similarity = d + _RETURN_DEVIATION_WEIGHT * abs(cand_period_return - ref_period_return)
            out.append(
                PatternMatch(
                    code=code,
                    start_date=win[0][0],
                    end_date=win[-1][0],
                    distance=d,
                    period_return=cand_period_return,
                    similarity=similarity,
                )
            )
        return out


def _validate_query(query: PatternQuery) -> None:
    if query.window_days < _MIN_WINDOW_DAYS:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"window_days must be >= {_MIN_WINDOW_DAYS}, got {query.window_days}",
        )
    if len(query.reference.closes) != query.window_days:
        raise QuantError(
            "INVALID_ARGUMENT",
            "reference length must equal window_days "
            f"({len(query.reference.closes)} vs {query.window_days})",
        )
    if query.recent_trading_days < query.window_days:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"recent_trading_days ({query.recent_trading_days}) must be "
            f">= window_days ({query.window_days})",
        )
    if query.top_n <= 0:
        raise QuantError("INVALID_ARGUMENT", f"top_n must be > 0, got {query.top_n}")


def _group_by_code(table: object) -> dict[str, list[tuple[date_cls, Decimal | None]]]:
    # Avoid a hard pyarrow import at module top — repo returns a
    # ``pa.Table`` but type-only.
    codes = table.column("code").to_pylist()  # type: ignore[attr-defined]
    dates = table.column("trade_date").to_pylist()  # type: ignore[attr-defined]
    closes = table.column("close_qfq").to_pylist()  # type: ignore[attr-defined]
    grouped: dict[str, list[tuple[date_cls, Decimal | None]]] = defaultdict(list)
    for code, d, c in zip(codes, dates, closes, strict=True):
        grouped[code].append((d, c))
    for rows in grouped.values():
        rows.sort(key=lambda r: r[0])
    return dict(grouped)


def _safe_ratio(num: float, denom: float) -> float:
    if denom == 0.0:
        return 1.0
    return num / denom


def _period_return(first: float, last: float) -> float:
    """Cumulative return over a window: ``last/first - 1``.

    Returns ``0.0`` for a degenerate ``first == 0`` (treats the window as
    flat for ranking purposes — better than blowing up).
    """
    if first == 0.0:
        return 0.0
    return last / first - 1.0


def _ratio_within(ref: float, cand: float, k: float) -> bool:
    if ref == 0.0 or cand == 0.0:
        return True
    r = cand / ref if ref > 0 else ref / cand
    if r < 0:
        r = -r
    return (1.0 / k) <= r <= k
