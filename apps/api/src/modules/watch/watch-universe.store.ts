/**
 * File-backed HK / US universe cache (`docs/modules/W-0-watch.md` §7).
 *
 * One JSON file per market — written atomically when the refresh op
 * completes, served verbatim by the controller.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { type StockBasic } from '@quant/shared';
import { atomicWriteJson, readJsonOr } from './domain/atomic-json.js';
import { WATCH_DATA_DIR } from './watch-task.store.js';

// On-disk format: per-market file, each row only carries `code` + `name`.
// The market is implicit in the filename (`universe_hk.json` → 'hk') and
// is joined back when the rows are returned to consumers — keeps the
// disk footprint smaller and avoids the redundant column in git diffs.
const UniverseRowSchema = z.object({ code: z.string().min(1), name: z.string() }).strict();
type UniverseRow = z.infer<typeof UniverseRowSchema>;
const UniverseFileSchema = z.array(UniverseRowSchema);

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
    const rows: readonly UniverseRow[] = parsed.success ? parsed.data : [];
    if (!parsed.success) {
      this.logger.warn(
        `universe_${market}.json failed validation, returning empty: ${parsed.error.message}`,
      );
    }
    const joined: readonly StockBasic[] = rows.map((r) => ({
      market,
      code: r.code,
      name: r.name,
    }));
    this.cache.set(market, joined);
    return joined;
  }

  async replace(market: 'hk' | 'us', rows: readonly StockBasic[]): Promise<void> {
    this.cache.set(market, rows);
    // Strip the redundant `market` column before writing — it is implicit
    // in the filename. `load()` joins it back on read.
    const stripped: readonly UniverseRow[] = rows.map((r) => ({ code: r.code, name: r.name }));
    await atomicWriteJson(this.filePath(market), stripped);
  }
}
