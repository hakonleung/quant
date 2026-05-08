/**
 * AI-analysis cache. Keyed by SHA-256 of the enriched entries payload —
 * any user edit to the ledger invalidates the cache automatically.
 *
 * Storage: `data/_ledger/ai-cache.json` — flat object mapping hash →
 * `LedgerAnalysis`. Capped at MAX_ENTRIES; LRU by insertion order so a
 * user who keeps editing then reverting still gets a warm cache for the
 * common state.
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { LedgerAnalysisSchema, type LedgerAnalysis, type EnrichedLedgerEntry } from '@quant/shared';
import { z } from 'zod';

import { atomicWriteJson, readJsonOr } from '../watch/domain/atomic-json.js';
import { LEDGER_DATA_DIR } from './ledger.token.js';

const MAX_ENTRIES = 32;

const CacheFileSchema = z.record(z.string(), LedgerAnalysisSchema);

@Injectable()
export class LedgerCacheStore implements OnModuleInit {
  private readonly logger = new Logger(LedgerCacheStore.name);
  private cache = new Map<string, LedgerAnalysis>();
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(@Inject(LEDGER_DATA_DIR) private readonly dataDir: string) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  private get file(): string {
    return `${this.dataDir}/ai-cache.json`;
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
      const raw = await readJsonOr<unknown>(this.file, {});
      const parsed = CacheFileSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn(
          `ai-cache.json failed validation, starting empty: ${parsed.error.message}`,
        );
        this.cache = new Map();
      } else {
        this.cache = new Map(Object.entries(parsed.data));
      }
      this.loaded = true;
    });
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

  get(key: string): LedgerAnalysis | null {
    return this.cache.get(key) ?? null;
  }

  /** Insert / update + persist atomically. */
  async put(key: string, value: LedgerAnalysis): Promise<void> {
    return this.withLock(async () => {
      this.cache.delete(key);
      this.cache.set(key, value);
      while (this.cache.size > MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      await atomicWriteJson(this.file, Object.fromEntries(this.cache));
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}
