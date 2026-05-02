"""Test-only Flight server entrypoint used by the NestJS contract tests.

Spins :class:`QuantFlightServer` on the requested port with a fixed
in-memory stock-meta dataset (no real data sources). The TS-side test
helper (`apps/api/test/_util/flight-server.ts`) starts this process,
waits for "READY <port>" on stdout, then runs assertions against the
real wire protocol.

Not intended for production composition. Production wiring will live in
``quant_rpc/main.py`` once the persistence layer is wired through config.
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from quant_core.domain.types.stock import StockMeta
from quant_core.services.stock_meta_service import StockMetaService

from quant_rpc.handlers import HandlerRegistry
from quant_rpc.ops.stock_meta import GetStockMetaBatchHandler, ListByIndustryHandler
from quant_rpc.server import QuantFlightServer

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence


def _seed() -> tuple[StockMeta, ...]:
    updated = datetime(2026, 5, 1, 0, 0, 0, tzinfo=UTC)
    return (
        StockMeta(
            code="600519.SH",
            name="贵州茅台",  # 贵州茅台
            name_pinyin="GZMT",
            exchange="SH",
            board="MAIN",
            industry_sw_l1="食品饮料",  # 食品饮料
            industry_sw_l2="白酒",  # 白酒
            industry_sw_l3="高端白酒",
            list_date=date(2001, 8, 27),
            delist_date=None,
            total_share=Decimal("1256197800"),
            float_share=Decimal("1256197800"),
            status="NORMAL",
            updated_at=updated,
        ),
        StockMeta(
            code="000858.SZ",
            name="五粮液",  # 五粮液
            name_pinyin="WLY",
            exchange="SZ",
            board="MAIN",
            industry_sw_l1="食品饮料",
            industry_sw_l2="白酒",
            industry_sw_l3="高端白酒",
            list_date=date(1998, 4, 27),
            delist_date=None,
            total_share=Decimal("3881608700"),
            float_share=Decimal("3881608700"),
            status="NORMAL",
            updated_at=updated,
        ),
    )


class _InMemoryRepo:
    def __init__(self, items: tuple[StockMeta, ...]) -> None:
        self._by_code = {m.code: m for m in items}

    def upsert_many(self, items: Iterable[StockMeta]) -> None:  # pragma: no cover
        for item in items:
            self._by_code[item.code] = item

    def get(self, code: str) -> StockMeta | None:
        return self._by_code.get(code)

    def get_many(self, codes: Sequence[str]) -> list[StockMeta]:
        out: list[StockMeta] = []
        for code in codes:
            item = self._by_code.get(code)
            if item is not None:
                out.append(item)
        return out

    def list_by_industry(self, sw_l2: str) -> list[StockMeta]:
        return sorted(
            (m for m in self._by_code.values() if m.industry_sw_l2 == sw_l2),
            key=lambda m: m.code,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Quant Flight server (test fixture)")
    parser.add_argument("--port", type=int, default=0, help="bind port (0 = ephemeral)")
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    logging.basicConfig(level=logging.WARNING)

    service = StockMetaService(_InMemoryRepo(_seed()))
    registry = HandlerRegistry()
    registry.register(GetStockMetaBatchHandler(service))
    registry.register(ListByIndustryHandler(service))

    server = QuantFlightServer(registry, location=f"grpc://{args.host}:{args.port}")
    print(f"READY {server.port}", flush=True)
    try:
        server.serve()
    except KeyboardInterrupt:  # pragma: no cover - signal path
        server.shutdown()
    return 0


if __name__ == "__main__":  # pragma: no cover - entrypoint
    sys.exit(main())
