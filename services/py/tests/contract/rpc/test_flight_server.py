"""Contract tests for :class:`QuantFlightServer`.

The server is started in-process on an ephemeral port via a fixture; a real
``flight.FlightClient`` exercises the wire protocol end-to-end (descriptor
parsing, op dispatch, error envelope, trace-id middleware).
"""

from __future__ import annotations

import json
import threading
from typing import TYPE_CHECKING

import pyarrow as pa
import pytest
from pyarrow import flight
from quant_core.errors import QuantError
from quant_rpc import (
    TRACE_HEADER,
    HandlerRegistry,
    QuantFlightServer,
    get_trace_id,
    parse_flight_error_payload,
)

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping


# -- test handlers ------------------------------------------------------


class EchoHandler:
    """Returns the args as a 1-row table; also captures trace_id seen at execute time."""

    op = "echo"
    schema = pa.schema(
        [
            ("name", pa.string()),
            ("value", pa.int64()),
            ("trace_id_seen", pa.string()),
        ]
    )

    def __init__(self) -> None:
        self.last_trace_id: str = ""

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        self.last_trace_id = get_trace_id()
        return pa.table(
            {
                "name": [str(args.get("name", ""))],
                "value": [int(args.get("value", 0))],  # type: ignore[call-overload]
                "trace_id_seen": [self.last_trace_id],
            },
            schema=self.schema,
        )


class BoomHandler:
    """Always raises a domain error — used to test the error envelope."""

    op = "boom"
    schema = pa.schema([("ignored", pa.string())])

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        raise QuantError(
            "STOCK_NOT_FOUND",
            "no such stock",
            {"code": str(args.get("code", "?"))},
        )


# -- fixtures -----------------------------------------------------------


@pytest.fixture
def echo_handler() -> EchoHandler:
    return EchoHandler()


@pytest.fixture
def server(echo_handler: EchoHandler) -> Iterator[QuantFlightServer]:
    registry = HandlerRegistry()
    registry.register(echo_handler)
    registry.register(BoomHandler())
    srv = QuantFlightServer(registry, location="grpc://127.0.0.1:0")
    thread = threading.Thread(target=srv.serve, daemon=True)
    thread.start()
    try:
        yield srv
    finally:
        srv.shutdown()
        thread.join(timeout=5)


@pytest.fixture
def client(server: QuantFlightServer) -> Iterator[flight.FlightClient]:
    cli = flight.FlightClient(f"grpc://127.0.0.1:{server.port}")
    try:
        yield cli
    finally:
        cli.close()


def _descriptor(op: str, args: dict[str, object] | None = None) -> flight.FlightDescriptor:
    return flight.FlightDescriptor.for_command(
        json.dumps({"op": op, "args": args or {}}).encode("utf-8")
    )


# -- tests --------------------------------------------------------------


@pytest.mark.contract
class TestFlightServerHappyPath:
    def test_get_flight_info_returns_handler_schema(
        self, client: flight.FlightClient, echo_handler: EchoHandler
    ) -> None:
        info = client.get_flight_info(_descriptor("echo"))
        assert info.schema == echo_handler.schema
        assert len(info.endpoints) == 1

    def test_do_get_returns_handler_table(self, client: flight.FlightClient) -> None:
        info = client.get_flight_info(_descriptor("echo", {"name": "alpha", "value": 7}))
        table = client.do_get(info.endpoints[0].ticket).read_all()
        assert table.num_rows == 1
        assert table.column("name").to_pylist() == ["alpha"]
        assert table.column("value").to_pylist() == [7]


@pytest.mark.contract
class TestFlightServerErrors:
    def test_unknown_op_raises_not_found(self, client: flight.FlightClient) -> None:
        with pytest.raises(flight.FlightServerError) as excinfo:
            client.get_flight_info(_descriptor("nope"))
        payload = parse_flight_error_payload(str(excinfo.value))
        assert payload is not None
        assert payload["code"] == "NOT_FOUND"
        assert "nope" in payload["message"]

    def test_handler_quant_error_propagates_with_details(self, client: flight.FlightClient) -> None:
        info = client.get_flight_info(_descriptor("boom", {"code": "999999"}))
        with pytest.raises(flight.FlightServerError) as excinfo:
            client.do_get(info.endpoints[0].ticket).read_all()
        payload = parse_flight_error_payload(str(excinfo.value))
        assert payload is not None
        assert payload["code"] == "STOCK_NOT_FOUND"
        assert payload["details"] == {"code": "999999"}

    def test_descriptor_with_non_json_command_raises_invalid_argument(
        self, client: flight.FlightClient
    ) -> None:
        bad = flight.FlightDescriptor.for_command(b"\xff not json")
        with pytest.raises(flight.FlightServerError) as excinfo:
            client.get_flight_info(bad)
        payload = parse_flight_error_payload(str(excinfo.value))
        assert payload is not None
        assert payload["code"] == "INVALID_ARGUMENT"

    def test_descriptor_missing_op_field_raises_invalid_argument(
        self, client: flight.FlightClient
    ) -> None:
        bad = flight.FlightDescriptor.for_command(json.dumps({"args": {}}).encode("utf-8"))
        with pytest.raises(flight.FlightServerError) as excinfo:
            client.get_flight_info(bad)
        payload = parse_flight_error_payload(str(excinfo.value))
        assert payload is not None
        assert payload["code"] == "INVALID_ARGUMENT"

    def test_descriptor_with_bad_args_type_raises_invalid_argument(
        self, client: flight.FlightClient
    ) -> None:
        bad = flight.FlightDescriptor.for_command(
            json.dumps({"op": "echo", "args": "not-an-object"}).encode("utf-8")
        )
        with pytest.raises(flight.FlightServerError) as excinfo:
            client.get_flight_info(bad)
        payload = parse_flight_error_payload(str(excinfo.value))
        assert payload is not None
        assert payload["code"] == "INVALID_ARGUMENT"

    def test_path_descriptor_rejected(self, client: flight.FlightClient) -> None:
        bad = flight.FlightDescriptor.for_path("anything")
        with pytest.raises(flight.FlightServerError) as excinfo:
            client.get_flight_info(bad)
        payload = parse_flight_error_payload(str(excinfo.value))
        assert payload is not None
        assert payload["code"] == "INVALID_ARGUMENT"


@pytest.mark.contract
class TestFlightServerTracing:
    def test_client_supplied_trace_id_is_seen_by_handler(
        self, client: flight.FlightClient, echo_handler: EchoHandler
    ) -> None:
        opts = flight.FlightCallOptions(headers=[(TRACE_HEADER.encode(), b"trace-from-client")])
        info = client.get_flight_info(_descriptor("echo"), options=opts)
        client.do_get(info.endpoints[0].ticket, options=opts).read_all()
        assert echo_handler.last_trace_id == "trace-from-client"

    def test_missing_trace_id_is_synthesised(
        self, client: flight.FlightClient, echo_handler: EchoHandler
    ) -> None:
        info = client.get_flight_info(_descriptor("echo"))
        client.do_get(info.endpoints[0].ticket).read_all()
        assert echo_handler.last_trace_id  # non-empty
        # uuid4 hex is 32 chars
        assert len(echo_handler.last_trace_id) == 32

    def test_trace_id_in_error_payload_matches_request_header(
        self, client: flight.FlightClient
    ) -> None:
        opts = flight.FlightCallOptions(headers=[(TRACE_HEADER.encode(), b"trace-err-xyz")])
        with pytest.raises(flight.FlightServerError) as excinfo:
            client.get_flight_info(_descriptor("nope"), options=opts)
        payload = parse_flight_error_payload(str(excinfo.value))
        assert payload is not None
        assert payload["trace_id"] == "trace-err-xyz"
