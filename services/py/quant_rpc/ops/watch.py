"""Flight ops for module W-0 watch.

* ``watch.quote_one`` — single realtime quote (one row, fixed schema)
* ``watch.universe_refresh`` — full HK / US universe snapshot

Both ops are stateless from the caller's perspective: the NestJS scheduler
invokes them with the minimum args required and persists results on its
side (`tasks.json` / `universe_*.json`).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

import pyarrow as pa

from quant_core.errors import QuantError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from quant_core.services.watch_quote_service import WatchQuoteService


_QUOTE_OP: Final[str] = "watch.quote_one"
_UNIVERSE_OP: Final[str] = "watch.universe_refresh"


WATCH_QUOTE_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        pa.field("market", pa.string()),
        pa.field("code", pa.string()),
        pa.field("last", pa.string()),
        pa.field("day_high", pa.string()),
        pa.field("day_low", pa.string()),
        pa.field("prev_close", pa.string()),
        pa.field("amount", pa.string()),
        pa.field("volume", pa.string()),
        pa.field("ts", pa.timestamp("us", tz="UTC")),
    ]
)


WATCH_UNIVERSE_SCHEMA: Final[pa.Schema] = pa.schema(
    [
        pa.field("market", pa.string()),
        pa.field("code", pa.string()),
        pa.field("name", pa.string()),
    ]
)


def _require_str(args: Mapping[str, object], key: str) -> str:
    raw = args.get(key)
    if not isinstance(raw, str) or not raw:
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.{key} must be a non-empty string",
            {"got": type(raw).__name__},
        )
    return raw


def _require_market(args: Mapping[str, object]) -> str:
    market = _require_str(args, "market")
    if market not in ("a", "hk", "us"):
        raise QuantError(
            "INVALID_ARGUMENT",
            f"args.market must be one of a/hk/us, got {market!r}",
            {"market": market},
        )
    return market


class WatchQuoteOneHandler:
    """``watch.quote_one`` — args ``{"market": "a|hk|us", "code": "..."}``."""

    op = _QUOTE_OP
    schema = WATCH_QUOTE_SCHEMA

    __slots__ = ("_svc",)

    def __init__(self, svc: WatchQuoteService) -> None:
        self._svc = svc

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        market = _require_market(args)
        code = _require_str(args, "code")
        # ``Literal`` narrowing for the service call.
        if market == "a":
            quote = self._svc.fetch_one("a", code)
        elif market == "hk":
            quote = self._svc.fetch_one("hk", code)
        else:
            quote = self._svc.fetch_one("us", code)
        row = {
            "market": quote.market,
            "code": quote.code,
            "last": str(quote.last),
            "day_high": str(quote.day_high),
            "day_low": str(quote.day_low),
            "prev_close": str(quote.prev_close),
            "amount": str(quote.amount),
            "volume": str(quote.volume),
            "ts": quote.ts,
        }
        return pa.Table.from_pylist([row], schema=WATCH_QUOTE_SCHEMA)


class WatchUniverseRefreshHandler:
    """``watch.universe_refresh`` — args ``{"market": "hk|us"}``."""

    op = _UNIVERSE_OP
    schema = WATCH_UNIVERSE_SCHEMA

    __slots__ = ("_svc",)

    def __init__(self, svc: WatchQuoteService) -> None:
        self._svc = svc

    def execute(self, args: Mapping[str, object]) -> pa.Table:
        market = _require_market(args)
        if market == "a":
            raise QuantError(
                "INVALID_ARGUMENT",
                "watch.universe_refresh only supports hk/us",
                {"market": market},
            )
        if market == "hk":
            rows = self._svc.refresh_universe("hk")
        else:
            rows = self._svc.refresh_universe("us")
        if not rows:
            return WATCH_UNIVERSE_SCHEMA.empty_table()
        return pa.Table.from_pylist(
            [{"market": r.market, "code": r.code, "name": r.name} for r in rows],
            schema=WATCH_UNIVERSE_SCHEMA,
        )
