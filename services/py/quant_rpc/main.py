"""Production Flight server entrypoint.

Wires the real adapter chain (AKShare sources, Parquet repos, file KV)
and starts :class:`QuantFlightServer` on a stable port. NestJS connects
to this server over Arrow Flight.

Configuration via env (CLAUDE.md §1.4 / §2 — no global singletons):

* ``QUANT_DATA_ROOT``       — root for cache files (default: ``./data``)
* ``QUANT_FLIGHT_HOST``     — bind host (default: ``127.0.0.1``)
* ``QUANT_FLIGHT_PORT``     — bind port (default: ``8815``)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from quant_cache.file_kv_store import FileKeyValueStore
from quant_cache.parquet_kline_repo import ParquetKlineRepo
from quant_cache.parquet_stock_meta_repo import ParquetStockMetaRepo
from quant_core.adapters.clock import SystemClock
from quant_core.ports.stock_meta_source import StockMetaSource
from quant_core.services.kline_service import KlineService
from quant_core.services.source_chain import SourceChain
from quant_core.services.stock_meta_service import StockMetaService
from quant_core.services.stock_meta_sync_service import StockMetaSyncService
from quant_io.sources.akshare_kline import AKShareKlineSource
from quant_io.sources.akshare_stock_meta import AKShareStockMetaSource

from quant_rpc.handlers import HandlerRegistry
from quant_rpc.ops.kline import ListKlineWatermarksHandler, SyncKlineForCodeHandler
from quant_rpc.ops.stock_meta import (
    GetStockMetaBatchHandler,
    ListAllHandler,
    ListByIndustryHandler,
)
from quant_rpc.ops.stock_meta_admin import (
    CheckSourcesHandler,
    EnrichOneHandler,
    SyncFullHandler,
)
from quant_rpc.server import QuantFlightServer


def _data_root() -> Path:
    return Path(os.environ.get("QUANT_DATA_ROOT", "./data")).resolve()


def main() -> int:
    parser = argparse.ArgumentParser(description="Quant Flight server (production)")
    parser.add_argument("--host", default=os.environ.get("QUANT_FLIGHT_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("QUANT_FLIGHT_PORT", "8815")),
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=os.environ.get("QUANT_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("quant_rpc.main")

    root = _data_root()
    meta_path = root / "meta" / "stocks.parquet"
    kline_root = root / "kline"
    kv_root = root / "_state"
    log.info("data_root=%s", root)

    clock = SystemClock()
    meta_repo = ParquetStockMetaRepo(meta_path)
    kline_repo = ParquetKlineRepo(kline_root)
    kv = FileKeyValueStore(kv_root, clock)

    meta_chain: SourceChain[StockMetaSource] = SourceChain([AKShareStockMetaSource()])
    sync_service = StockMetaSyncService(meta_chain, meta_repo, kv, clock)
    meta_service = StockMetaService(meta_repo)

    kline_source = AKShareKlineSource()
    kline_service = KlineService(kline_source, kline_repo, clock)

    registry = HandlerRegistry()
    registry.register(GetStockMetaBatchHandler(meta_service))
    registry.register(ListByIndustryHandler(meta_service))
    registry.register(ListAllHandler(meta_service))
    registry.register(CheckSourcesHandler(sync_service))
    registry.register(SyncFullHandler(sync_service))
    registry.register(EnrichOneHandler(sync_service))
    registry.register(SyncKlineForCodeHandler(kline_service))
    registry.register(ListKlineWatermarksHandler(meta_repo, kline_repo))

    server = QuantFlightServer(registry, location=f"grpc://{args.host}:{args.port}")
    log.info("flight server listening on grpc://%s:%d", args.host, server.port)
    print(f"READY {server.port}", flush=True)
    try:
        server.serve()
    except KeyboardInterrupt:
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
