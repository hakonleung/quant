"""Pattern-matching orchestration (modules/04-pattern-matching.md §6).

Two operations:

* :meth:`reference_from_stock` — build a :class:`PatternSeries` from a
  real stock's qfq close window (used by the UI's "pick a stock as
  reference" flow).
* :meth:`find_similar` — delegate to the injected
  :class:`PatternEngine`. Service stays thin so the engine can be
  swapped (DTW / shapelet / ANN) without touching callers.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from quant_core.domain.types.pattern import PatternSeries, PatternSourceFromStock
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from datetime import date

    from quant_core.domain.types.pattern import PatternMatch, PatternQuery
    from quant_core.ports.kline_repo import KlineRepo
    from quant_core.ports.pattern_engine import PatternEngine


class PatternService:
    """Thin facade over :class:`PatternEngine` plus a reference builder."""

    __slots__ = ("_engine", "_repo")

    def __init__(self, repo: KlineRepo, engine: PatternEngine) -> None:
        self._repo = repo
        self._engine = engine

    def reference_from_stock(self, code: str, start: date, end: date) -> PatternSeries:
        """Extract a qfq close series for ``code`` over ``[start, end]``.

        Raises:
            QuantError: ``INVALID_ARGUMENT`` if the range is empty or
                inverted; ``KLINE_DATA_MISSING`` if no bars cover the
                requested window.
        """
        if start > end:
            raise QuantError("INVALID_ARGUMENT", f"start ({start}) must be <= end ({end})")
        table = self._repo.get_range(code, start, end, columns=["trade_date", "close_qfq"])
        if table.num_rows == 0:
            raise QuantError(
                "KLINE_DATA_MISSING",
                f"no qfq closes for {code} in [{start}, {end}]",
                {"code": code},
            )
        closes = [c for c in table.column("close_qfq").to_pylist() if c is not None]
        if not closes:
            raise QuantError(
                "KLINE_DATA_MISSING",
                f"all qfq closes for {code} in [{start}, {end}] are null",
                {"code": code},
            )
        return PatternSeries(
            closes=tuple(closes),
            source=PatternSourceFromStock(
                kind="from_stock", code=code, start_date=start, end_date=end
            ),
        )

    def find_similar(self, query: PatternQuery) -> list[PatternMatch]:
        return self._engine.find_similar(query)
