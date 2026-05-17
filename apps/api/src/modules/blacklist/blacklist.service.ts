/**
 * A-share noise-reduction blacklist (`docs/modules/12-blacklist.md`).
 *
 * Computes from the local `stock_metas.parquet` snapshot — the
 * `ret_20d / ret_90d / ret_250d` columns are the same forward-adjusted
 * stage returns the old Python `compute_ashare_blacklist` Flight op
 * used to derive on-the-fly from kline. `StockMetricsComputeService`
 * (kline-worker + nightly backfill) keeps them fresh.
 *
 * Criteria: a code is blacklisted iff every available stage return is
 * **≤** its threshold and at least one stage return is computable:
 *
 *     ret_20d  > 30 %   → keep
 *     ret_90d  > 60 %   → keep
 *     ret_250d > 150 %  → keep
 *
 * A code whose three returns are all null (fewer than 21 cached daily
 * rows, or non-positive baseline) is **not** blacklisted — mirrors the
 * Python `checked_any` guard so brand-new IPOs are revisited once
 * enough history accumulates.
 *
 * Owned by the cron orchestrator's blacklist scan kind. Workers and
 * the controller never call this directly — they read the cached
 * snapshot via the store.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { isAShareCode, type BlacklistSnapshot, type StockSnapshotDto } from '@quant/shared';

import { CLOCK, type Clock } from '../../common/clock.js';
import { StockMetaService } from '../stock-meta/stock-meta.service.js';
import { BlacklistStore } from './blacklist.store.js';

/** (ret_* column on snapshot, threshold as fractional return). */
const THRESHOLDS: readonly (readonly [
  keyof StockSnapshotDto['returns'],
  number,
])[] = [
  ['ret_20d', 0.3],
  ['ret_90d', 0.6],
  ['ret_250d', 1.5],
];

@Injectable()
export class BlacklistService {
  private readonly logger = new Logger(BlacklistService.name);

  constructor(
    @Inject(BlacklistStore) private readonly store: BlacklistStore,
    @Inject(StockMetaService) private readonly meta: StockMetaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Walk the A-share universe via the snapshot, derive the blacklist,
   * replace the persisted snapshot, return the new value. Errors
   * propagate so the cron can log them.
   */
  async refresh(traceId: string): Promise<BlacklistSnapshot> {
    const snapshots = await this.meta.snapshotAll(traceId);
    const aShareSnapshots = snapshots.filter((s) => isAShareCode(s.meta.code));
    const codes: string[] = [];
    let latestAsof: string | null = null;
    for (const snap of aShareSnapshots) {
      if (isBlacklisted(snap)) codes.push(snap.meta.code);
      const asof = snap.asof;
      if (asof !== null && (latestAsof === null || asof > latestAsof)) {
        latestAsof = asof;
      }
    }
    codes.sort();
    const now = this.clock.now();
    const snap: BlacklistSnapshot = {
      codes: Object.freeze([...codes]),
      asof: latestAsof ?? toIsoDate(now),
      universeSize: aShareSnapshots.length,
      computedAt: now.toISOString(),
    };
    await this.store.replace(snap);
    this.logger.log(
      `blacklist_refreshed size=${String(codes.length)} asof=${snap.asof} universe=${String(snap.universeSize)} traceId=${traceId}`,
    );
    return snap;
  }
}

/**
 * True iff the snapshot's stage returns are all weak. Mirrors
 * `_is_blacklisted` in the now-removed Python service: at least one
 * threshold must be evaluable, and none may exceed its cutoff.
 */
function isBlacklisted(snap: StockSnapshotDto): boolean {
  let checkedAny = false;
  for (const [field, threshold] of THRESHOLDS) {
    const raw = snap.returns[field];
    if (raw === null) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    checkedAny = true;
    if (v > threshold) return false;
  }
  return checkedAny;
}

function toIsoDate(d: Date): string {
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
