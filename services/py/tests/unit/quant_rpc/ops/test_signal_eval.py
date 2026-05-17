"""Unit tests for ``EvaluateSignalHandler`` (Flight op `evaluate_signal`)."""

from __future__ import annotations

import json

import pytest
from quant_core.errors import QuantError
from quant_rpc.ops.signal_eval import EvaluateSignalHandler


def _run(args: dict[str, object]) -> dict[str, object]:
    table = EvaluateSignalHandler().execute(args)
    raw = table.column("payload_json")[0].as_py()
    assert isinstance(raw, str)
    payload = json.loads(raw)
    assert isinstance(payload, dict)
    return payload


# --- golden path -----------------------------------------------------------


def test_round_trip_minimal_payload() -> None:
    args: dict[str, object] = {
        "signals": [
            {"signal_date": "2024-01-02", "code": "A"},
        ],
        "klines": {
            "A": {
                "trade_date": ["2024-01-02", "2024-01-03", "2024-01-04"],
                "open_qfq": [10.0, 11.0, 12.0],
            },
        },
        "holdings": [1],
    }
    out = _run(args)
    assert out["holdings"] == [1]
    obs = out["observations"]
    assert isinstance(obs, list)
    assert len(obs) == 1
    o = obs[0]
    assert o["signalDate"] == "2024-01-02"
    assert o["entryDate"] == "2024-01-03"
    assert o["exitDate"] == "2024-01-04"
    assert o["holding"] == 1
    assert o["entryPx"] == pytest.approx(11.0)
    assert o["exitPx"] == pytest.approx(12.0)
    assert o["ret"] == pytest.approx(12 / 11 - 1)
    summary = out["summary"]
    assert isinstance(summary, list)
    assert len(summary) == 1
    assert summary[0]["holding"] == 1
    assert summary[0]["n"] == 1
    assert out["signalDateRange"] == ["2024-01-02", "2024-01-02"]
    assert out["universeSizeAvg"] == pytest.approx(1.0)


def test_accepts_camel_case_field_names() -> None:
    args: dict[str, object] = {
        "signals": [{"signalDate": "2024-01-02", "code": "A"}],
        "klines": {
            "A": {
                "tradeDate": ["2024-01-02", "2024-01-03", "2024-01-04"],
                "openQfq": ["10", "11", "12"],
            },
        },
        "holdings": [1],
    }
    out = _run(args)
    assert len(out["observations"]) == 1  # type: ignore[arg-type]


def test_empty_signals_returns_empty_observations() -> None:
    out = _run({"signals": [], "klines": {}, "holdings": [5, 10]})
    assert out["observations"] == []
    assert out["holdings"] == [5, 10]
    assert out["signalDateRange"] is None
    assert out["universeSizeAvg"] == 0.0


# --- error paths -----------------------------------------------------------


def test_missing_signals_raises() -> None:
    with pytest.raises(QuantError) as exc:
        EvaluateSignalHandler().execute({"klines": {}, "holdings": [1]})
    assert exc.value.code == "INVALID_ARGUMENT"


def test_missing_klines_raises() -> None:
    with pytest.raises(QuantError) as exc:
        EvaluateSignalHandler().execute({"signals": [], "holdings": [1]})
    assert exc.value.code == "INVALID_ARGUMENT"


def test_missing_holdings_raises() -> None:
    with pytest.raises(QuantError) as exc:
        EvaluateSignalHandler().execute({"signals": [], "klines": {}})
    assert exc.value.code == "INVALID_ARGUMENT"


def test_bad_date_string_raises() -> None:
    with pytest.raises(QuantError) as exc:
        EvaluateSignalHandler().execute(
            {
                "signals": [{"signal_date": "not-a-date", "code": "A"}],
                "klines": {},
                "holdings": [1],
            }
        )
    assert exc.value.code == "INVALID_ARGUMENT"


def test_kline_length_mismatch_raises() -> None:
    with pytest.raises(QuantError) as exc:
        EvaluateSignalHandler().execute(
            {
                "signals": [],
                "klines": {
                    "A": {"trade_date": ["2024-01-02"], "open_qfq": [10.0, 11.0]},
                },
                "holdings": [1],
            }
        )
    assert exc.value.code == "INVALID_ARGUMENT"


def test_holdings_must_be_positive_ints() -> None:
    with pytest.raises(QuantError) as exc:
        EvaluateSignalHandler().execute({"signals": [], "klines": {}, "holdings": [1, -3]})
    assert exc.value.code == "INVALID_ARGUMENT"


def test_bool_in_holdings_rejected() -> None:
    # isinstance(True, int) is True in Python; the handler must filter it.
    with pytest.raises(QuantError) as exc:
        EvaluateSignalHandler().execute({"signals": [], "klines": {}, "holdings": [True]})
    assert exc.value.code == "INVALID_ARGUMENT"


def test_non_numeric_price_string_rejected() -> None:
    with pytest.raises(QuantError) as exc:
        EvaluateSignalHandler().execute(
            {
                "signals": [],
                "klines": {
                    "A": {"trade_date": ["2024-01-02"], "open_qfq": ["abc"]},
                },
                "holdings": [1],
            }
        )
    assert exc.value.code == "INVALID_ARGUMENT"


# --- schema ----------------------------------------------------------------


def test_handler_op_and_schema() -> None:
    h = EvaluateSignalHandler()
    assert h.op == "evaluate_signal"
    assert h.schema.names == ["payload_json"]
