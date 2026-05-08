/**
 * Per-user AI-analysis cache. Keyed by `userId → hash(enriched entries)`
 * so eviction (32-cap LRU) is per-user and `clearForUser` is one map
 * delete. On-disk shape mirrors the in-memory layout —
 * `data/users/{userId}/_ledger/ai-cache.json` is a flat object map.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { LedgerAnalysisSchema, type EnrichedLedgerEntry, type LedgerAnalysis } from '@quant/shared';
import { z } from 'zod';

import { atomicWriteJson, readJsonOr } from '../watch/domain/atomic-json.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';

const MAX_ENTRIES_PER_USER = 32;

const CacheFileSchema = z.record(z.string(), LedgerAnalysisSchema);

@Injectable()
export class LedgerCacheStore {
  private readonly logger = new Logger(LedgerCacheStore.name);
  private readonly caches = new Map<string, Map<string, LedgerAnalysis>>();
  private readonly mutexes = new Map<string, Promise<unknown>>();
  private readonly loaded = new Set<string>();

  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfigShape) {}

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
    await this.ensureLoaded(userId);
    return this.caches.get(userId)?.get(key) ?? null;
  }

  async put(userId: string, key: string, value: LedgerAnalysis): Promise<void> {
    return this.withLock(userId, async () => {
      await this.ensureLoadedLocked(userId);
      const cache = this.cacheFor(userId);
      cache.delete(key);
      cache.set(key, value);
      while (cache.size > MAX_ENTRIES_PER_USER) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      const file = this.fileFor(userId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await atomicWriteJson(file, Object.fromEntries(cache));
    });
  }

  /** Drop a user's cache (on logout / account delete). */
  async clearForUser(userId: string): Promise<void> {
    return this.withLock(userId, async () => {
      this.caches.delete(userId);
      this.loaded.delete(userId);
    });
  }

  private cacheFor(userId: string): Map<string, LedgerAnalysis> {
    let m = this.caches.get(userId);
    if (m === undefined) {
      m = new Map();
      this.caches.set(userId, m);
    }
    return m;
  }

  private fileFor(userId: string): string {
    return path.join(this.cfg.dataRoot, 'users', userId, '_ledger', 'ai-cache.json');
  }

  private async ensureLoaded(userId: string): Promise<void> {
    if (this.loaded.has(userId)) return;
    return this.withLock(userId, async () => this.ensureLoadedLocked(userId));
  }

  private async ensureLoadedLocked(userId: string): Promise<void> {
    if (this.loaded.has(userId)) return;
    const file = this.fileFor(userId);
    const raw = await readJsonOr<unknown>(file, {});
    const parsed = CacheFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`ai-cache.json for ${userId} failed validation, starting empty`);
      this.caches.set(userId, new Map());
    } else {
      this.caches.set(userId, new Map(Object.entries(parsed.data)));
    }
    this.loaded.add(userId);
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
