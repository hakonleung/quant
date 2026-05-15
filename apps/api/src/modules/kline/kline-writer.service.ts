/**
 * Persistence side of the kline pipeline.
 *
 * Receives batches of `KlineRow` (typically arriving from a Python
 * `compute_kline_for_code` Flight op — see plan §3.3) and writes them
 * to the NestJS-owned `DuckDBParquetTimeSeriesStore`. The store handles
 * partitioning by `code.slice(0, 3)` and LSM delta + compaction
 * semantics — this service is the narrow seam where call sites (cron,
 * controllers, scripts) can drop a batch in.
 *
 * Compaction is exposed as `compact(prefix?)` so a cron job can call it
 * post-close (plan §3.2 / docs/perf/kline-lsm-write.md).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import type { TimeSeriesStore } from '../../common/storage/ports/time-series-store.port.js';
import type { KlineRow } from './kline.row.js';
import { KLINE_TIME_SERIES_STORE } from './kline.token.js';

@Injectable()
export class KlineWriterService {
  private readonly logger = new Logger(KlineWriterService.name);

  constructor(@Inject(KLINE_TIME_SERIES_STORE) private readonly store: TimeSeriesStore<KlineRow>) {}

  /**
   * Append a batch of bars. Empty batches are a no-op (avoids
   * generating zero-row delta files).
   *
   * Atomicity: per the time-series store contract, either every row in
   * the batch becomes visible to readers, or none does.
   */
  async appendBars(rows: readonly KlineRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.store.appendBars(rows);
    this.logger.log(
      `appended ${String(rows.length)} bars across ${String(uniquePrefixCount(rows))} partition(s)`,
    );
  }

  /** Convenience for single-code writes — same semantics as `appendBars`. */
  async appendBarsForCode(code: string, rows: readonly KlineRow[]): Promise<void> {
    if (rows.length === 0) return;
    const stamped: KlineRow[] = rows.map((r) => (r.code === code ? r : { ...r, code }));
    await this.appendBars(stamped);
  }

  /**
   * Coalesce delta files into the base partition. Caller scopes via
   * `partitionKey` (the 3-digit code prefix) or leaves it `undefined`
   * to compact every partition that has deltas.
   *
   * Safe to call concurrently with reads; writes to the same partition
   * are serialised by the store's per-partition mutex.
   */
  async compact(partitionKey?: string): Promise<void> {
    await this.store.compact(partitionKey);
    this.logger.log(
      partitionKey === undefined
        ? 'compacted all kline partitions'
        : `compacted kline partition ${partitionKey}`,
    );
  }
}

function uniquePrefixCount(rows: readonly KlineRow[]): number {
  const prefixes = new Set<string>();
  for (const r of rows) prefixes.add(r.code.slice(0, 3));
  return prefixes.size;
}
