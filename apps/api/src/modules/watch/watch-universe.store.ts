/**
 * File-backed HK / US universe cache (`docs/modules/W-0-watch.md` §7).
 *
 * One JSON file per market — written atomically when the refresh op
 * completes, served verbatim by the controller. **NOT** user-scoped:
 * universe data is shared across all users (it's the listing of all
 * tradable codes, not a user's preferences).
 */

import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { type StockBasic } from '@quant/shared';

import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';
import { atomicWriteJson, readJsonOr } from './domain/atomic-json.js';

const UniverseRowSchema = z.object({ code: z.string().min(1), name: z.string() }).strict();
type UniverseRow = z.infer<typeof UniverseRowSchema>;
const UniverseFileSchema = z.array(UniverseRowSchema);

@Injectable()
export class WatchUniverseStore {
  private readonly logger = new Logger(WatchUniverseStore.name);
  private readonly cache = new Map<'hk' | 'us', readonly StockBasic[]>();

  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfigShape) {}

  private filePath(market: 'hk' | 'us'): string {
    return path.join(this.cfg.dataRoot, 'watch', `universe_${market}.json`);
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
    const stripped: readonly UniverseRow[] = rows.map((r) => ({ code: r.code, name: r.name }));
    await atomicWriteJson(this.filePath(market), stripped);
  }
}
