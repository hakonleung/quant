"""Flight op for pattern matching (modules/04 + modules/07-frontend.md §4.5).

One op:

* ``find_similar_patterns`` — given a reference window
  ``(code, start_date, end_date)`` and a candidate ``universe`` (or all
  stocks if empty), return the top-N similar windows ordered by
  ascending DTW distance.

Payload travels over the same JSON-tunnel as sentiment so the gateway
can map directly onto ``PatternFindSimilarResponse``.
"""

from __future__ import annotations

import json
from datetime import date as date_cls
from datetime import datetime
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Final

import pyarrow as pa

from quant_core.domain.types.pattern import PatternQuery
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.ports.stock_meta_repo import StockMetaRepo
    from quant_core.services.pattern_service import PatternService


PAYLOAD_SCHEMA: Final[pa.Schema] = pa.schema([("payload_json", pa.string())])

_DEFAULT_LOOKBACK: Final[int] = 250
_DEFAULT_TOP_N: Final[int] = 20
_MAX_UNIVERSE: Final[int] = 6000


def _require_str(args: "Mapping[str, object]", key: str) -> str:
    raw = args.get(key)
    if not isinstance(raw, str) or not raw:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a non-empty string",
            {"key": key},
        )
    return raw


def _opt_int(args: "Mapping[str, object]", key: str, *, default: int) -> int:
    raw = args.get(key)
    if raw is None:
        return default
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be an int",
            {"key": key, "got": type(raw).__name__},
        )
    return raw


def _parse_date(s: str, key: str) -> date_cls:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError as exc:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be YYYY-MM-DD; got {s!r}",
            {"key": key},
        ) from exc


class FindSimilarPatternsHandler:
    """``find_similar_patterns`` — DTW-based window search."""

    op = "find_similar_patterns"
    schema = PAYLOAD_SCHEMA

    __slots__ = ("_clock", "_meta_repo", "_service")

    def __init__(
        self,
        service: "PatternService",
        meta_repo: "StockMetaRepo",
        clock: Any,
    ) -> None:
        self._service = service
        self._meta_repo = meta_repo
        self._clock = clock

    def execute(self, args: "Mapping[str, object]") -> pa.Table:
        code = _require_str(args, "code")
        start_str = _require_str(args, "start_date")
        end_str = _require_str(args, "end_date")
        start = _parse_date(start_str, "start_date")
        end = _parse_date(end_str, "end_date")
        if start > end:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"start_date ({start}) must be <= end_date ({end})",
            )
        lookback = _opt_int(args, "lookback_days", default=_DEFAULT_LOOKBACK)
        top_n = _opt_int(args, "top_n", default=_DEFAULT_TOP_N)

        raw_universe = args.get("universe")
        universe: list[str]
        if raw_universe is None or (isinstance(raw_universe, list) and len(raw_universe) == 0):
            universe = [m.code for m in self._meta_repo.list_all()][:_MAX_UNIVERSE]
        elif isinstance(raw_universe, list):
            universe = []
            for i, item in enumerate(raw_universe):
                if not isinstance(item, str) or not item:
                    raise QuantError(
                        "INVALID_ARGUMENT",
                        f"args.universe[{i}] must be a non-empty string",
                        {"index": i},
                    )
                universe.append(item)
            if len(universe) > _MAX_UNIVERSE:
                raise QuantError(
                    "INVALID_ARGUMENT",
                    f"args.universe too large: {len(universe)} > {_MAX_UNIVERSE}",
                    {"limit": _MAX_UNIVERSE},
                )
        else:
            raise QuantError(
                "INVALID_ARGUMENT",
                "args.universe must be a list of strings or omitted",
            )

        reference = self._service.reference_from_stock(code, start, end)
        window_days = max(1, (end - start).days + 1)
        asof_end = self._clock.now().date()

        query = PatternQuery(
            reference=reference,
            universe=tuple(universe),
            window_days=window_days,
            asof_end=asof_end,
            lookback_days=lookback,
            top_n=top_n,
        )
        matches = self._service.find_similar(query)

        # name lookup — best-effort; absent meta → empty string
        name_by_code: dict[str, str] = {}
        for m in self._meta_repo.list_all():
            name_by_code[m.code] = m.name

        rows: list[dict[str, Any]] = []
        for hit in matches:
            rows.append(
                {
                    "code": hit.code,
                    "name": name_by_code.get(hit.code, ""),
                    "startDate": hit.start_date.isoformat(),
                    "endDate": hit.end_date.isoformat(),
                    "distance": float(hit.distance),
                }
            )
        payload = {
            "referenceCode": code,
            "referenceStart": start.isoformat(),
            "referenceEnd": end.isoformat(),
            "windowDays": window_days,
            "matches": rows,
        }
        # Suppress unused-import for timedelta on lint variants
        _ = timedelta(0)
        return pa.Table.from_pylist(
            [{"payload_json": json.dumps(payload, ensure_ascii=False)}],
            schema=PAYLOAD_SCHEMA,
        )
