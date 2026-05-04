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
from quant_cache.parquet_sentiment_cache import ParquetSentimentCache
from quant_cache.parquet_stock_meta_repo import ParquetStockMetaRepo
from quant_core.adapters.clock import SystemClock
from quant_core.adapters.pattern.dtw_engine import DTWPatternEngine
from quant_core.services.pattern_service import PatternService
from quant_core.errors import QuantError
from quant_core.ports.stock_meta_source import StockMetaSource
from quant_core.services.kline_service import KlineService
from quant_core.services.news_sentiment_service import NewsSentimentService
from quant_core.services.nl_to_dsl_service import NlToDslService
from quant_core.services.screen_service import ScreenService
from quant_core.services.source_chain import SourceChain
from quant_core.services.stock_meta_service import StockMetaService
from quant_core.services.stock_meta_sync_service import StockMetaSyncService
from quant_core.services.financials_service import FinancialsService
from quant_core.services.universe_screen_service import UniverseScreenService
from quant_io.llm.providers import build_llm_client
from quant_io.sources.akshare_financials import (
    AKShareFinancialsBulkSource,
    AKShareFinancialsPerStockEnricher,
)
from quant_io.sources.akshare_kline import AKShareKlineSource
from quant_io.sources.akshare_stock_meta import AKShareStockMetaSource

from quant_rpc.handlers import HandlerRegistry
from quant_rpc.ops.kline import ListKlineWatermarksHandler, SyncKlineForCodeHandler
from quant_rpc.ops.kline_read import ListKlineBulkLastNHandler, ListKlineForCodeHandler
from quant_rpc.ops.nl_screen import NlScreenHandler
from quant_rpc.ops.pattern import FindSimilarPatternsHandler
from quant_rpc.ops.trading_calendar import GetLatestTradeDayHandler
from quant_rpc.ops.sentiment import (
    AnalyzeManyStockSentimentHandler,
    AnalyzeOneStockSentimentHandler,
    GetCachedMarketSentimentHandler,
    GetCachedStockSentimentHandler,
)
from quant_rpc.ops.financials import (
    BulkSyncFinancialsHandler,
    EnrichFinancialsForCodeHandler,
    FindStaleFinancialsHandler,
)
from quant_rpc.ops.stock_snapshot import ListStockSnapshotsHandler
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

    # Warm up V8 on the main thread before gRPC worker threads spin up.
    # akshare's `stock_zh_a_daily` (sina) constructs `py_mini_racer.MiniRacer()`
    # per call to decode encrypted params; concurrent first-time
    # instantiation across threads triggers V8's address_pool_manager
    # double-init check and aborts the process.
    import py_mini_racer  # noqa: PLC0415

    py_mini_racer.MiniRacer().eval("1+1")

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
    screen_service = ScreenService(kline_repo)
    universe_service = UniverseScreenService(meta_repo)
    financials_service = FinancialsService(
        repo=meta_repo,
        clock=clock,
        bulk=AKShareFinancialsBulkSource(),
        enricher=AKShareFinancialsPerStockEnricher(),
    )

    # NL→DSL translator shares the aggregator LLM (cheap tier when
    # available). Without API keys we degrade the same way sentiment
    # does — only `nl_screen` calls fail with a clear error.
    nl_translator: NlToDslService | None
    try:
        nl_translator = NlToDslService(build_llm_client(use_flash=True))
        log.info("nl translator ready")
    except QuantError as exc:
        nl_translator = None
        log.warning("nl translator disabled — LLM not configured: %s", exc)

    sentiment_root = root / "sentiment"
    sentiment_cache = ParquetSentimentCache(sentiment_root, clock)
    # Construct LLM clients lazily — without provider keys the server
    # still serves cached reads (GET); only the analyze ops fail with a
    # clear ``LLM_NOT_CONFIGURED`` error code.
    sentiment_service: NewsSentimentService | None
    try:
        sentiment_service = NewsSentimentService(
            search_llm=build_llm_client(need_web_search=True),
            aggregator_llm=build_llm_client(use_flash=True),
            cache=sentiment_cache,
            meta_repo=meta_repo,
            clock=clock,
        )
        log.info("sentiment service ready")
    except QuantError as exc:
        sentiment_service = None
        log.warning("sentiment LLM not configured — analyze ops disabled: %s", exc)

    registry = HandlerRegistry()
    registry.register(GetStockMetaBatchHandler(meta_service))
    registry.register(ListByIndustryHandler(meta_service))
    registry.register(ListAllHandler(meta_service))
    registry.register(ListStockSnapshotsHandler(meta_service, kline_service))
    registry.register(BulkSyncFinancialsHandler(financials_service))
    registry.register(EnrichFinancialsForCodeHandler(financials_service))
    registry.register(FindStaleFinancialsHandler(financials_service))
    registry.register(CheckSourcesHandler(sync_service))
    registry.register(SyncFullHandler(sync_service))
    registry.register(EnrichOneHandler(sync_service))
    registry.register(SyncKlineForCodeHandler(kline_service))
    registry.register(ListKlineWatermarksHandler(meta_repo, kline_repo))
    registry.register(ListKlineForCodeHandler(kline_service))
    registry.register(ListKlineBulkLastNHandler(kline_service, meta_repo))
    registry.register(GetCachedStockSentimentHandler(sentiment_cache, clock))
    registry.register(AnalyzeOneStockSentimentHandler(sentiment_service))
    registry.register(GetCachedMarketSentimentHandler(sentiment_cache, clock))
    registry.register(AnalyzeManyStockSentimentHandler(sentiment_service))
    pattern_engine = DTWPatternEngine(kline_repo)
    pattern_service = PatternService(kline_repo, pattern_engine)
    registry.register(FindSimilarPatternsHandler(pattern_service, meta_repo, clock))
    registry.register(GetLatestTradeDayHandler(clock))
    registry.register(
        NlScreenHandler(
            translator=nl_translator,
            screen_service=screen_service,
            universe_service=universe_service,
            meta_repo=meta_repo,
            clock=clock,
        )
    )

    # Visible at startup: every Flight op the gateway can call. If the
    # NestJS controller logs `unknown op: 'foo'`, scan this line first
    # — it usually means the server is running stale code from before
    # the op was registered.
    log.info("flight ops registered: %s", ",".join(sorted(registry._handlers)))

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
