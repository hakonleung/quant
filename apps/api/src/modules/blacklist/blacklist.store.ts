/**
 * Cache of the daily-computed A-share blacklist.
 *
 * Storage model is a single-row `RecordStore`: pk = `'singleton'`, with
 * `codes` JSON-encoded into a VARCHAR column. The store keeps the
 * snapshot + a code Set in memory after `load()`; `has(code)` is sync
 * and O(1).
 */

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EMPTY_BLACKLIST, type BlacklistSnapshot } from '@quant/shared';
import { z } from 'zod';

import type { RecordStore, RecordTableSpec } from '../../common/storage/ports/record-store.port.js';
import { BLACKLIST_RECORD_STORE } from './blacklist.token.js';

const SINGLETON_KEY = 'singleton' as const;

export interface BlacklistRow {
  readonly id: typeof SINGLETON_KEY;
  readonly codes_json: string;
  readonly asof: string;
  readonly universeSize: number;
  readonly computedAt: string;
}

export const BlacklistRowSchema = z.object({
  id: z.literal(SINGLETON_KEY),
  codes_json: z.string(),
  asof: z.string(),
  universeSize: z.number(),
  computedAt: z.string(),
});

export const BLACKLIST_TABLE_SPEC: RecordTableSpec<BlacklistRow> = {
  table: 'blacklist',
  schema: BlacklistRowSchema,
  pk: (row) => row.id,
  columns: [
    { name: 'id', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'codes_json', type: 'VARCHAR', nullable: false },
    { name: 'asof', type: 'VARCHAR', nullable: false },
    { name: 'universeSize', type: 'INTEGER', nullable: false },
    { name: 'computedAt', type: 'VARCHAR', nullable: false },
  ],
};

@Injectable()
export class BlacklistStore implements OnModuleInit {
  private readonly logger = new Logger(BlacklistStore.name);
  private snap: BlacklistSnapshot = EMPTY_BLACKLIST;
  private codeSet: ReadonlySet<string> = new Set();
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(@Inject(BLACKLIST_RECORD_STORE) private readonly store: RecordStore<BlacklistRow>) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
      const row = await this.store.get(SINGLETON_KEY);
      if (row !== null) {
        this.adoptRow(row);
        this.loaded = true;
        this.logger.log(`loaded blacklist size=${String(this.codeSet.size)}`);
        return;
      }
      this.snap = EMPTY_BLACKLIST;
      this.codeSet = new Set();
      this.loaded = true;
      this.logger.log('blacklist empty (no record store row)');
    });
  }

  snapshot(): BlacklistSnapshot {
    return this.snap;
  }

  has(code: string): boolean {
    return this.codeSet.has(code);
  }

  async replace(snap: BlacklistSnapshot): Promise<BlacklistSnapshot> {
    return this.withLock(async () => {
      await this.store.upsert(this.toRow(snap));
      await this.store.flush();
      this.adoptSnapshot(snap);
      return this.snap;
    });
  }

  private adoptSnapshot(snap: BlacklistSnapshot): void {
    this.snap = snap;
    this.codeSet = new Set(snap.codes);
  }

  private adoptRow(row: BlacklistRow): void {
    const snap = this.fromRow(row);
    this.adoptSnapshot(snap);
  }

  private toRow(snap: BlacklistSnapshot): BlacklistRow {
    return {
      id: SINGLETON_KEY,
      codes_json: JSON.stringify(snap.codes),
      asof: snap.asof,
      universeSize: snap.universeSize,
      computedAt: snap.computedAt,
    };
  }

  private fromRow(row: BlacklistRow): BlacklistSnapshot {
    let codes: readonly string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.codes_json);
      if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === 'string')) {
        codes = parsed;
      }
    } catch (err) {
      this.logger.warn(`blacklist codes_json malformed, treating as empty: ${String(err)}`);
    }
    return {
      codes,
      asof: row.asof,
      universeSize: row.universeSize,
      computedAt: row.computedAt,
    };
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}
