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
from quant_cache.flat_prefix_kline_repo import FlatPrefixKlineRepo
from quant_cache.parquet_stock_meta_repo import ParquetStockMetaRepo
from quant_core.adapters.clock import SystemClock
from quant_core.adapters.pattern.dtw_engine import DTWPatternEngine
from quant_core.errors import QuantError
from quant_core.ports.stock_meta_source import StockMetaSource
from quant_core.services.financials_service import FinancialsService
from quant_core.services.kline_service import KlineService
from quant_core.services.pattern_service import PatternService
from quant_core.services.screen_service import ScreenService
from quant_core.services.source_chain import SourceChain
from quant_core.services.stock_meta_service import StockMetaService
from quant_core.services.stock_meta_sync_service import StockMetaSyncService
from quant_core.services.universe_screen_service import UniverseScreenService
from quant_core.services.watch_quote_service import WatchQuoteService
from quant_io.sources.akshare_financials import (
    AKShareFinancialsBulkSource,
    AKShareFinancialsPerStockEnricher,
)
from quant_io.sources.akshare_kline import AKShareKlineSource
from quant_io.sources.akshare_stock_meta import AKShareStockMetaSource
from quant_io.sources.akshare_watch import AKShareWatchSource

from quant_rpc.handlers import HandlerRegistry
from quant_rpc.ops.blacklist import ComputeAshareBlacklistHandler
from quant_rpc.ops.financials import (
    BulkSyncFinancialsHandler,
    EnrichFinancialsForCodeHandler,
    FindStaleFinancialsHandler,
)
from quant_rpc.ops.kline import SyncKlineForCodeHandler
from quant_rpc.ops.pattern import FindSimilarPatternsHandler
from quant_rpc.ops.screen_ops import ScreenRunHandler
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
from quant_rpc.ops.stock_metrics import (
    UpsertStockMetricsForCodeHandler,
    UpsertStockMetricsForCodesHandler,
)
from quant_rpc.ops.stock_snapshot import ListStockSnapshotsHandler
from quant_rpc.ops.trading_calendar import GetLatestTradeDayHandler
from quant_rpc.ops.watch import WatchQuoteOneHandler, WatchUniverseRefreshHandler
from quant_rpc.server import QuantFlightServer


def _data_root() -> Path:
    """Resolve the canonical ``data/`` directory.

    Defaults to ``./data`` relative to the **process CWD**. That's brittle
    — running ``uv run --directory services/py python -m quant_rpc.main``
    silently resolves to ``services/py/data`` (which doesn't exist) and
    every repo loads as empty. The fail-fast assertion in
    :func:`_assert_data_root_ok` catches that on startup.

    Override via ``QUANT_DATA_ROOT`` env var to be explicit.
    """
    return Path(os.environ.get("QUANT_DATA_ROOT", "./data")).resolve()


def _assert_data_root_ok(root: Path, log: logging.Logger) -> None:
    """Refuse to start when ``data_root`` clearly isn't the canonical one.

    Three checks, in order of cheapness:

    1. The directory must exist.
    2. ``stock_metas.parquet`` must exist (every deployment has one).
    3. ``stock_metas.parquet`` must have at least one row — if it's
       empty, the service can boot but every meta-driven response (`/api/
       stocks`, `/api/stocks/snapshots`, blacklist refresh, screen
       universe) silently returns empty, which is the exact regression
       this guard was added to prevent.
    """
    if not root.is_dir():
        msg = (
            f"data_root {root} does not exist or is not a directory. "
            "Set QUANT_DATA_ROOT to the canonical data/ path, or launch "
            "the service from the repo root."
        )
        log.error(msg)
        raise SystemExit(msg)
    meta_path = root / "stock_metas.parquet"
    if not meta_path.is_file():
        msg = (
            f"meta parquet missing at {meta_path}. Either data_root is "
            "wrong or the meta cron has never run; either way the service "
            "would serve empty meta to every caller."
        )
        log.error(msg)
        raise SystemExit(msg)
    # Cheap row-count probe — avoids loading the whole parquet, but
    # confirms there's at least one row so we don't boot into the
    # "5512 rows on disk somewhere else, but this file is empty" state.
    import pyarrow.parquet as pq

    metadata = pq.read_metadata(str(meta_path))
    if metadata.num_rows == 0:
        msg = (
            f"meta parquet {meta_path} has zero rows — refusing to boot. "
            "Run the meta sync cron, or point QUANT_DATA_ROOT at the "
            "canonical data/ directory."
        )
        log.error(msg)
        raise SystemExit(msg)
    log.info(
        "data_root_ok root=%s meta_rows=%d", root, metadata.num_rows
    )


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
    import py_mini_racer

    py_mini_racer.MiniRacer().eval("1+1")

    root = _data_root()
    _assert_data_root_ok(root, log)
    meta_path = root / "stock_metas.parquet"
    # One canonical kline store, owned by NestJS's KlineWriterService at
    # `data/kline/<prefix>.parquet`. The Python in-process readers
    # (screen / pattern / blacklist) hit the same files through
    # FlatPrefixKlineRepo; the float64 → decimal128 cast happens at the
    # repo boundary so business code keeps working in Decimal.
    kline_root = root / "kline"
    kv_root = root / "_state"
    log.info("data_root=%s", root)

    clock = SystemClock()
    meta_repo = ParquetStockMetaRepo(meta_path)
    kline_repo = FlatPrefixKlineRepo(kline_root)
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

    # NL→DSL has migrated to NestJS (apps/api/src/modules/screen/nl-to-dsl.service.ts);
    # Python no longer carries the translator or its prompt. Only the
    # AST-execution `screen_run` op is served from this process.

    # All LLM-using flows (NL→DSL, ledger analyze, TA analyze, news
    # sentiment, agent loop) live in NestJS now. Python kline / meta /
    # pattern / blacklist / watch / financials remain — they are all
    # pure compute / IO over the parquet store.

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
    registry.register(UpsertStockMetricsForCodeHandler(meta_repo, kline_repo, clock))
    registry.register(UpsertStockMetricsForCodesHandler(meta_repo, kline_repo, clock))
    watch_source = AKShareWatchSource()
    watch_service = WatchQuoteService(quotes=watch_source, universe=watch_source)
    registry.register(WatchQuoteOneHandler(watch_service))
    registry.register(WatchUniverseRefreshHandler(watch_service))

    pattern_engine = DTWPatternEngine(kline_repo)
    pattern_service = PatternService(kline_repo, pattern_engine)
    registry.register(FindSimilarPatternsHandler(pattern_service, meta_repo, clock))
    registry.register(
        ComputeAshareBlacklistHandler(
            meta_repo=meta_repo,
            kline_repo=kline_repo,
            clock=clock,
        )
    )
    registry.register(GetLatestTradeDayHandler(clock))
    # NL→DSL lives in NestJS now (apps/api/src/modules/screen/nl-to-dsl.service.ts);
    # only AST execution stays here. The legacy `nl_screen` + `nl_to_dsl`
    # ops have been removed.
    registry.register(
        ScreenRunHandler(
            screen_service=screen_service,
            universe_service=universe_service,
            meta_repo=meta_repo,
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
