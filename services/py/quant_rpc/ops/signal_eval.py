"""Flight op for screen-signal evaluation.

One op:

* ``evaluate_signal`` — event-study style: given a list of
  ``(signal_date, code)`` pairs the screen emitted plus the relevant
  forward-adjusted open bars per code, return the realised
  ``(signal_date, code, holding) → ret`` observations plus per-holding
  distribution stats.

Python is compute-only here (CLAUDE.md §2.1) — the **caller** (NestJS)
reads parquet, narrows the kline window to the codes/dates it needs,
and ships everything in the args. No storage IO on this side.

Payload travels over the same JSON-tunnel as sentiment / pattern so
the gateway can map directly onto the response DTO.
"""

from __future__ import annotations

import json
from datetime import date as date_cls
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import TYPE_CHECKING, Any, Final

import pyarrow as pa
from quant_core.domain.pure.signal_eval import evaluate_signal
from quant_core.domain.types.signal_eval import Bar, SignalInput
from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping


PAYLOAD_SCHEMA: Final[pa.Schema] = pa.schema([("payload_json", pa.string())])

_MAX_SIGNALS: Final[int] = 200_000
_MAX_BARS: Final[int] = 2_000_000
_MAX_HOLDINGS: Final[int] = 32


class EvaluateSignalHandler:
    """``evaluate_signal`` — event-study return distribution per holding."""

    op = "evaluate_signal"
    schema = PAYLOAD_SCHEMA

    __slots__ = ()

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        signals = _parse_signals(args.get("signals"))
        bars_by_code = _parse_klines(args.get("klines"))
        holdings = _parse_holdings(args.get("holdings"))
        baselines = _parse_baselines(args.get("baselines"))

        result = evaluate_signal(signals, bars_by_code, holdings, baselines=baselines)

        payload: dict[str, Any] = {
            "holdings": list(result.holdings),
            "universeSizeAvg": result.universe_size_avg,
            "signalDateRange": (
                [result.signal_date_range[0].isoformat(), result.signal_date_range[1].isoformat()]
                if result.signal_date_range is not None
                else None
            ),
            "observations": [
                {
                    "signalDate": o.signal_date.isoformat(),
                    "code": o.code,
                    "holding": o.holding,
                    "entryDate": o.entry_date.isoformat(),
                    "entryPx": float(o.entry_px),
                    "exitDate": o.exit_date.isoformat(),
                    "exitPx": float(o.exit_px),
                    "ret": o.ret,
                    "baselineMean": o.baseline_mean,
                    "excessRet": o.excess_ret,
                }
                for o in result.observations
            ],
            "summary": [
                {
                    "holding": s.holding,
                    "n": s.n,
                    "mean": s.mean,
                    "median": s.median,
                    "std": s.std,
                    "p05": s.p05,
                    "p25": s.p25,
                    "p75": s.p75,
                    "p95": s.p95,
                    "winRate": s.win_rate,
                    "sharpeLike": s.sharpe_like,
                }
                for s in result.summary
            ],
            "baselineSummary": (
                [
                    {
                        "holding": b.holding,
                        "n": b.n,
                        "universeMean": b.universe_mean,
                        "universeStd": b.universe_std,
                    }
                    for b in result.baseline_summary
                ]
                if result.baseline_summary is not None
                else None
            ),
            "spreadSummary": (
                [
                    {
                        "holding": s.holding,
                        "n": s.n,
                        "spreadMean": s.spread_mean,
                        "spreadStd": s.spread_std,
                        "spreadTStat": s.spread_t_stat,
                        "winRate": s.win_rate,
                    }
                    for s in result.spread_summary
                ]
                if result.spread_summary is not None
                else None
            ),
        }
        return pa.Table.from_pylist(
            [{"payload_json": json.dumps(payload, ensure_ascii=False)}],
            schema=PAYLOAD_SCHEMA,
        )


# -- parsing helpers --------------------------------------------------------


def _parse_signals(raw: object) -> list[SignalInput]:
    if not isinstance(raw, list):
        raise QuantError(
            "INVALID_ARGUMENT",
            "args.signals must be a list of {signal_date, code} objects",
        )
    if len(raw) > _MAX_SIGNALS:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.signals too large: {len(raw)} > {_MAX_SIGNALS}",
            {"limit": _MAX_SIGNALS},
        )
    out: list[SignalInput] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.signals[{i}] must be an object",
                {"index": i},
            )
        sd_raw = item.get("signal_date") or item.get("signalDate")
        code_raw = item.get("code")
        if not isinstance(sd_raw, str) or not sd_raw:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.signals[{i}].signal_date must be a YYYY-MM-DD string",
                {"index": i},
            )
        if not isinstance(code_raw, str) or not code_raw:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.signals[{i}].code must be a non-empty string",
                {"index": i},
            )
        out.append(
            SignalInput(signal_date=_parse_date(sd_raw, f"signals[{i}].signal_date"), code=code_raw)
        )
    return out


def _parse_klines(raw: object) -> dict[str, tuple[Bar, ...]]:
    if not isinstance(raw, dict):
        raise QuantError(
            "INVALID_ARGUMENT",
            "args.klines must be an object mapping code -> {trade_date[], open_qfq[]}",
        )
    out: dict[str, tuple[Bar, ...]] = {}
    total_bars = 0
    for code, payload in raw.items():
        if not isinstance(code, str) or not code:
            raise QuantError(
                "INVALID_ARGUMENT",
                "args.klines keys must be non-empty code strings",
            )
        if not isinstance(payload, dict):
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.klines[{code!r}] must be an object",
                {"code": code},
            )
        dates_raw = payload.get("trade_date") or payload.get("tradeDate")
        px_raw = payload.get("open_qfq") or payload.get("openQfq")
        if not isinstance(dates_raw, list) or not isinstance(px_raw, list):
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.klines[{code!r}] must contain parallel arrays 'trade_date' and 'open_qfq'",
                {"code": code},
            )
        if len(dates_raw) != len(px_raw):
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.klines[{code!r}] trade_date/open_qfq length mismatch: "
                f"{len(dates_raw)} vs {len(px_raw)}",
                {"code": code},
            )
        total_bars += len(dates_raw)
        if total_bars > _MAX_BARS:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"total bar rows exceeds {_MAX_BARS}",
                {"limit": _MAX_BARS},
            )
        bars: list[Bar] = []
        for j, (d_raw, p_raw) in enumerate(zip(dates_raw, px_raw, strict=True)):
            if not isinstance(d_raw, str) or not d_raw:
                raise QuantError(
                    "INVALID_ARGUMENT",
                    f"args.klines[{code!r}].trade_date[{j}] must be a YYYY-MM-DD string",
                    {"code": code, "index": j},
                )
            bars.append(
                Bar(
                    trade_date=_parse_date(d_raw, f"klines[{code!r}].trade_date[{j}]"),
                    open_qfq=_coerce_decimal(p_raw, f"klines[{code!r}].open_qfq[{j}]"),
                )
            )
        out[code] = tuple(bars)
    return out


def _parse_holdings(raw: object) -> list[int]:
    if not isinstance(raw, list) or not raw:
        raise QuantError(
            "INVALID_ARGUMENT",
            "args.holdings must be a non-empty list of positive ints",
        )
    if len(raw) > _MAX_HOLDINGS:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.holdings too large: {len(raw)} > {_MAX_HOLDINGS}",
            {"limit": _MAX_HOLDINGS},
        )
    out: list[int] = []
    for i, item in enumerate(raw):
        if isinstance(item, bool) or not isinstance(item, int):
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.holdings[{i}] must be a positive int",
                {"index": i, "got": type(item).__name__},
            )
        if item <= 0:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.holdings[{i}] must be > 0; got {item}",
                {"index": i},
            )
        out.append(item)
    return out


def _parse_baselines(
    raw: object,
) -> dict[int, dict[date_cls, tuple[float, float]]] | None:
    """Parse the optional ``baselines`` arg.

    Shape: ``{ "<holding>": { "YYYY-MM-DD": [mean, std] } }``.
    ``None`` / missing means "no baseline supplied".
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise QuantError(
            "INVALID_ARGUMENT",
            "args.baselines must be an object keyed by holding (int as str)",
        )
    out: dict[int, dict[date_cls, tuple[float, float]]] = {}
    for h_raw, series in raw.items():
        holding = _parse_holding_key(h_raw)
        out[holding] = _parse_baseline_series(h_raw, series)
    return out


def _parse_holding_key(h_raw: object) -> int:
    if not isinstance(h_raw, str):
        raise QuantError(
            "INVALID_ARGUMENT",
            "args.baselines keys must be stringified positive ints",
        )
    try:
        holding = int(h_raw)
    except ValueError as exc:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.baselines key {h_raw!r} is not an int",
        ) from exc
    if holding <= 0:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.baselines key must be > 0; got {holding}",
        )
    return holding


def _parse_baseline_series(h_raw: str, series: object) -> dict[date_cls, tuple[float, float]]:
    if not isinstance(series, dict):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.baselines[{h_raw!r}] must be an object {{date: [mean, std]}}",
        )
    parsed: dict[date_cls, tuple[float, float]] = {}
    for d_raw, pair in series.items():
        if not isinstance(d_raw, str) or not d_raw:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.baselines[{h_raw!r}] date key must be YYYY-MM-DD string",
            )
        d = _parse_date(d_raw, f"baselines[{h_raw!r}].{d_raw}")
        parsed[d] = _parse_baseline_pair(h_raw, d_raw, pair)
    return parsed


def _parse_baseline_pair(h_raw: str, d_raw: str, pair: object) -> tuple[float, float]:
    if not isinstance(pair, list) or len(pair) != 2:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.baselines[{h_raw!r}][{d_raw!r}] must be [mean, std]",
        )
    mean_raw, std_raw = pair
    return (
        _coerce_baseline_num(h_raw, d_raw, 0, mean_raw),
        _coerce_baseline_num(h_raw, d_raw, 1, std_raw),
    )


def _coerce_baseline_num(h_raw: str, d_raw: str, idx: int, value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.baselines[{h_raw!r}][{d_raw!r}][{idx}] must be numeric",
        )
    return float(value)


def _parse_date(s: str, key: str) -> date_cls:
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError as exc:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be YYYY-MM-DD; got {s!r}",
            {"key": key},
        ) from exc


def _coerce_decimal(raw: object, key: str) -> Decimal:
    """Accept int / float / numeric string; reject everything else.

    Float is the typical wire form for prices on this op (vs Decimal-as-
    string elsewhere) because the downstream stats are float-valued and
    Decimal precision adds no value to return distributions.
    """
    if isinstance(raw, bool):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be numeric, not bool",
            {"key": key},
        )
    if isinstance(raw, (int, float)):
        return Decimal(str(raw))
    if isinstance(raw, str):
        try:
            return Decimal(raw)
        except InvalidOperation as exc:
            raise QuantError(
                "INVALID_ARGUMENT",
                f"args.{key} is not a numeric string: {raw!r}",
                {"key": key},
            ) from exc
    raise QuantError(
        "INVALID_ARGUMENT",
        f"args.{key} must be a number or numeric string",
        {"key": key, "got": type(raw).__name__},
    )
