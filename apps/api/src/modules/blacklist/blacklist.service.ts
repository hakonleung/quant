/**
 * Calls the Python `compute_ashare_blacklist` Flight op and persists
 * the result through {@link BlacklistStore}.
 *
 * Owned by the cron orchestrator's `blacklist` scan kind. Workers and
 * the controller never call this directly — they read the cached
 * snapshot via the store.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { EMPTY_BLACKLIST, type BlacklistSnapshot } from '@quant/shared';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { CLOCK, type Clock } from '../../common/clock.js';
import { BlacklistStore } from './blacklist.store.js';
import { BLACKLIST_FLIGHT_CLIENT } from './blacklist.token.js';

@Injectable()
export class BlacklistService {
  private readonly logger = new Logger(BlacklistService.name);

  constructor(
    @Inject(BlacklistStore) private readonly store: BlacklistStore,
    @Inject(BLACKLIST_FLIGHT_CLIENT) private readonly flight: FlightClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Run the Python compute op and replace the persisted snapshot.
   * Returns the new snapshot. Errors propagate so the cron can log
   * them through its own scan-failure path.
   */
  async refresh(traceId: string): Promise<BlacklistSnapshot> {
    const result = await this.flight.doGet('compute_ashare_blacklist', {}, { traceId });
    const table = result.value;
    const codes: string[] = [];
    let asof = EMPTY_BLACKLIST.asof;
    let universeSize = EMPTY_BLACKLIST.universeSize;
    for (let i = 0; i < table.numRows; i++) {
      const proxy = table.get(i);
      if (proxy === null) continue;
      const row = proxy.toJSON() as {
        code?: unknown;
        asof?: unknown;
        universe_size?: unknown;
      };
      if (typeof row.code === 'string') codes.push(row.code);
      if (i === 0) {
        const a = decodeDateCell(row.asof);
        if (a !== null) asof = a;
        if (typeof row.universe_size === 'number') universeSize = row.universe_size;
      }
    }
    const snap: BlacklistSnapshot = {
      codes: Object.freeze([...codes]),
      asof,
      universeSize,
      computedAt: this.clock.now().toISOString(),
    };
    await this.store.replace(snap);
    this.logger.log(
      `blacklist_refreshed size=${String(codes.length)} asof=${asof} universe=${String(universeSize)} traceId=${traceId}`,
    );
    return snap;
  }
}

export function decodeDateCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${String(y)}-${m}-${d}`;
  }
  if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10);
  if (typeof value === 'number') {
    const ms = value > 1e8 ? value : value * 86_400_000;
    return decodeDateCell(new Date(ms));
  }
  if (typeof value === 'bigint') return decodeDateCell(Number(value));
  return null;
}
