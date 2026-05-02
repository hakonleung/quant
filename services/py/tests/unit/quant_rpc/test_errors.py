"""Unit tests for the Flight error envelope round-trip."""

from __future__ import annotations

import json

import pytest
from quant_core.errors import QuantError
from quant_rpc import flight_error_from_quant_error, parse_flight_error_payload


@pytest.mark.unit
class TestFlightErrorEnvelope:
    def test_round_trip(self) -> None:
        err = QuantError("STOCK_NOT_FOUND", "no such stock", {"code": "999999"})
        flight_err = flight_error_from_quant_error(err, trace_id="abc")
        payload = parse_flight_error_payload(str(flight_err))
        assert payload is not None
        assert payload["code"] == "STOCK_NOT_FOUND"
        assert payload["message"] == "no such stock"
        assert payload["trace_id"] == "abc"
        assert payload["details"] == {"code": "999999"}

    def test_round_trip_with_empty_details(self) -> None:
        err = QuantError("INTERNAL", "boom")
        flight_err = flight_error_from_quant_error(err, trace_id="t")
        payload = parse_flight_error_payload(str(flight_err))
        assert payload is not None
        assert payload["details"] == {}

    def test_parse_returns_none_for_non_envelope(self) -> None:
        assert parse_flight_error_payload("plain string with no json") is None

    def test_parse_returns_none_for_invalid_json(self) -> None:
        assert parse_flight_error_payload("prefix {not valid") is None

    def test_parse_returns_none_for_wrong_version(self) -> None:
        msg = json.dumps({"v": 99, "code": "X", "message": "m", "trace_id": "t", "details": {}})
        assert parse_flight_error_payload(msg) is None

    def test_parse_returns_none_for_missing_field(self) -> None:
        msg = json.dumps({"v": 1, "code": "X", "message": "m", "trace_id": "t"})
        assert parse_flight_error_payload(msg) is None

    def test_parse_returns_none_for_wrong_field_type(self) -> None:
        msg = json.dumps({"v": 1, "code": "X", "message": "m", "trace_id": 123, "details": {}})
        assert parse_flight_error_payload(msg) is None

    def test_parse_returns_none_for_non_object_root(self) -> None:
        assert parse_flight_error_payload("[1, 2, 3]") is None

    def test_parse_tolerates_grpc_prefix(self) -> None:
        # Real pyarrow client wraps the message; parser must locate the JSON.
        prefix = "Flight returned internal error, with message: "
        err = QuantError("INTERNAL", "x")
        envelope = str(flight_error_from_quant_error(err, trace_id="t"))
        payload = parse_flight_error_payload(prefix + envelope)
        assert payload is not None
        assert payload["code"] == "INTERNAL"
