/**
 * File-backed HK / US universe cache (`docs/modules/W-0-watch.md` §7).
 *
 * One JSON file per market — written atomically when the refresh op
 * completes, served verbatim by the controller.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { StockBasicSchema, type StockBasic } from '@quant/shared';
import { atomicWriteJson, readJsonOr } from './domain/atomic-json.js';
import { WATCH_DATA_DIR } from './watch-task.store.js';

const UniverseFileSchema = z.array(StockBasicSchema);

@Injectable()
export class WatchUniverseStore {
  private readonly logger = new Logger(WatchUniverseStore.name);
  private readonly cache = new Map<'hk' | 'us', readonly StockBasic[]>();

  constructor(@Inject(WATCH_DATA_DIR) private readonly dataDir: string) {}

  private filePath(market: 'hk' | 'us'): string {
    return `${this.dataDir}/universe_${market}.json`;
  }

  async load(market: 'hk' | 'us'): Promise<readonly StockBasic[]> {
    const cached = this.cache.get(market);
    if (cached !== undefined) return cached;
    const raw = await readJsonOr<unknown>(this.filePath(market), []);
    const parsed = UniverseFileSchema.safeParse(raw);
    const rows = parsed.success ? parsed.data : [];
    if (!parsed.success) {
      this.logger.warn(
        `universe_${market}.json failed validation, returning empty: ${parsed.error.message}`,
      );
    }
    this.cache.set(market, rows);
    return rows;
  }

  async replace(market: 'hk' | 'us', rows: readonly StockBasic[]): Promise<void> {
    this.cache.set(market, rows);
    await atomicWriteJson(this.filePath(market), rows);
  }
}
