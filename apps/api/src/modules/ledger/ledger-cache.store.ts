/**
 * Per-user AI-analysis cache. Keyed by `userId → hash(enriched entries)`
 * so eviction (32-cap LRU) is per-user and `clearForUser` is one map
 * delete.
 *
 * Backed by `UserScopedRecordStore<LedgerCacheRow>` — one parquet per
 * user at `data/users/{userId}/ledger_cache.parquet`; each cache entry
 * is one row keyed by hash, value JSON-encoded in `payload_json`.
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { LedgerAnalysisSchema, type EnrichedLedgerEntry, type LedgerAnalysis } from '@quant/shared';
import { z } from 'zod';

import { FileSystemUserScopedRecordStore } from '../../common/storage/adapters/filesystem-user-scoped-record.store.js';
import type { RecordTableSpec } from '../../common/storage/ports/record-store.port.js';
import type { UserScopedRecordStore } from '../../common/storage/ports/user-scoped-record-store.port.js';
import type { AuthConfigShape } from '../auth/config/auth.config.js';
import { LEDGER_CACHE_USER_RECORD_STORE } from './ledger-cache.tokens.js';

const MAX_ENTRIES_PER_USER = 32;

export interface LedgerCacheRow {
  readonly hash: string;
  readonly payload_json: string;
}

export const LedgerCacheRowSchema = z
  .object({ hash: z.string().min(1), payload_json: z.string() })
  .strict();

export const LEDGER_CACHE_TABLE_SPEC: RecordTableSpec<LedgerCacheRow> = {
  table: 'ledger_cache',
  schema: LedgerCacheRowSchema,
  pk: (row) => row.hash,
  columns: [
    { name: 'hash', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'payload_json', type: 'VARCHAR', nullable: false },
  ],
};

export function buildLedgerCacheUserScopedStore(
  cfg: AuthConfigShape,
  logger: { warn: (m: string) => void; log?: (m: string) => void },
): UserScopedRecordStore<LedgerCacheRow> {
  return new FileSystemUserScopedRecordStore<LedgerCacheRow>({
    dataRoot: cfg.dataRoot,
    spec: LEDGER_CACHE_TABLE_SPEC,
    logger,
  });
}

@Injectable()
export class LedgerCacheStore {
  private readonly logger = new Logger(LedgerCacheStore.name);
  private readonly mutexes = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(LEDGER_CACHE_USER_RECORD_STORE)
    private readonly inner: UserScopedRecordStore<LedgerCacheRow>,
  ) {
    void this.logger;
  }

  static keyFor(enriched: readonly EnrichedLedgerEntry[]): string {
    const slim = enriched.map((e) => ({
      d: e.date,
      a: e.pnlAmount,
      c: e.derivedClosingPosition,
      p: e.closingProvided,
    }));
    return createHash('sha256').update(JSON.stringify(slim)).digest('hex');
  }

  async get(userId: string, key: string): Promise<LedgerAnalysis | null> {
    const row = await this.inner.get(userId, key);
    if (row === null) return null;
    try {
      const parsed = LedgerAnalysisSchema.safeParse(JSON.parse(row.payload_json) as unknown);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async put(userId: string, key: string, value: LedgerAnalysis): Promise<void> {
    return this.withLock(userId, async () => {
      await this.inner.upsert(userId, { hash: key, payload_json: JSON.stringify(value) });
      // Evict oldest entries (FIFO) when over the per-user cap. Row
      // insertion order is preserved by the underlying record store,
      // so `list()` returns LRU-ordered entries.
      const rows = await this.inner.list(userId);
      if (rows.length > MAX_ENTRIES_PER_USER) {
        const toDelete = rows.slice(0, rows.length - MAX_ENTRIES_PER_USER).map((r) => r.hash);
        await this.inner.deleteMany(userId, toDelete);
      }
      await this.inner.flush(userId);
    });
  }

  /** Drop a user's cache (on logout / account delete). */
  async clearForUser(userId: string): Promise<void> {
    return this.withLock(userId, async () => {
      await this.inner.purge(userId);
      await this.inner.flush(userId);
    });
  }

  private async withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.mutexes.set(
      userId,
      next.catch(() => undefined),
    );
    return next;
  }
}
