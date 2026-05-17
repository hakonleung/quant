/**
 * Persistent cache for the backtest service. Two RecordStore-backed
 * parquet tables under `data/cache/`:
 *
 *   - `backtest_screen_cache.parquet`
 *       (key VARCHAR PK, last_trade_day DATE, codes_json VARCHAR)
 *     key = `<plan-base-key>|<asof YYYY-MM-DD>`
 *
 *   - `backtest_baseline_cache.parquet`
 *       (key VARCHAR PK, last_trade_day DATE, mean DOUBLE, std DOUBLE)
 *     key = `<holding>|<entry_day YYYY-MM-DD>`
 *
 * **Invalidation rule (the only one):** a cached row is fresh iff its
 * `last_trade_day` equals the kline store's *current* `last_trade_day`.
 * The kline parquet only mutates on the 15:15 BJT writer cron, so the
 * snapshot is monotonically advancing and one-day-resolution comparison
 * is sufficient. No TTL, no FIFO — we let the row stay until the next
 * trading day completes, then overwrite it on demand.
 *
 * Why a single `payload_json` column for screen results: the stored
 * value is a `string[]` whose length varies per plan/day; the
 * RecordStore port can't express `LIST<VARCHAR>` today (same shortcut
 * `SectorsStore` uses, see modules/sectors/sectors.store.ts).
 */

import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { RecordStore, RecordTableSpec } from '../../common/storage/ports/record-store.port.js';

export const BACKTEST_SCREEN_CACHE_STORE = Symbol('BACKTEST_SCREEN_CACHE_STORE');
export const BACKTEST_BASELINE_CACHE_STORE = Symbol('BACKTEST_BASELINE_CACHE_STORE');

// ---------------------------------------------------------------------------
// row shapes + table specs (referenced by the module providers)
// ---------------------------------------------------------------------------

export interface ScreenCacheRow {
  readonly key: string;
  /** ISO YYYY-MM-DD; DuckDB DATE column → JS Date in/out. */
  readonly last_trade_day: Date;
  /** JSON array of matched stock codes for this (planBaseKey, asof). */
  readonly codes_json: string;
}

const ScreenCacheRowSchema = z.object({
  key: z.string(),
  last_trade_day: z.date(),
  codes_json: z.string(),
});

export const BACKTEST_SCREEN_CACHE_SPEC: RecordTableSpec<ScreenCacheRow> = {
  table: 'backtest_screen_cache',
  schema: ScreenCacheRowSchema,
  pk: (row) => row.key,
  columns: [
    { name: 'key', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'last_trade_day', type: 'DATE', nullable: false },
    { name: 'codes_json', type: 'VARCHAR', nullable: false },
  ],
};

export interface BaselineCacheRow {
  readonly key: string;
  readonly last_trade_day: Date;
  readonly mean: number;
  readonly std: number;
}

const BaselineCacheRowSchema = z.object({
  key: z.string(),
  last_trade_day: z.date(),
  mean: z.number(),
  std: z.number(),
});

export const BACKTEST_BASELINE_CACHE_SPEC: RecordTableSpec<BaselineCacheRow> = {
  table: 'backtest_baseline_cache',
  schema: BaselineCacheRowSchema,
  pk: (row) => row.key,
  columns: [
    { name: 'key', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'last_trade_day', type: 'DATE', nullable: false },
    { name: 'mean', type: 'DOUBLE', nullable: false },
    { name: 'std', type: 'DOUBLE', nullable: false },
  ],
};

// ---------------------------------------------------------------------------
// wrapper
// ---------------------------------------------------------------------------

@Injectable()
export class BacktestCacheStore {
  constructor(
    @Inject(BACKTEST_SCREEN_CACHE_STORE)
    private readonly screenStore: RecordStore<ScreenCacheRow>,
    @Inject(BACKTEST_BASELINE_CACHE_STORE)
    private readonly baselineStore: RecordStore<BaselineCacheRow>,
  ) {}

  // ---- screen --------------------------------------------------------

  async getScreen(
    planBaseKey: string,
    asof: string,
    currentLastTradeDay: Date,
  ): Promise<readonly string[] | null> {
    const row = await this.screenStore.get(screenKey(planBaseKey, asof));
    if (row === null) return null;
    if (!sameDay(row.last_trade_day, currentLastTradeDay)) return null;
    return parseCodes(row.codes_json);
  }

  async setScreen(
    planBaseKey: string,
    asof: string,
    codes: readonly string[],
    currentLastTradeDay: Date,
  ): Promise<void> {
    await this.screenStore.upsert({
      key: screenKey(planBaseKey, asof),
      last_trade_day: currentLastTradeDay,
      codes_json: JSON.stringify(codes),
    });
  }

  // ---- baseline ------------------------------------------------------

  async getBaseline(
    holding: number,
    entryDay: string,
    currentLastTradeDay: Date,
  ): Promise<[number, number] | null> {
    const row = await this.baselineStore.get(baselineKey(holding, entryDay));
    if (row === null) return null;
    if (!sameDay(row.last_trade_day, currentLastTradeDay)) return null;
    return [row.mean, row.std];
  }

  async setBaselineMany(
    holding: number,
    entries: readonly { readonly entryDay: string; readonly mean: number; readonly std: number }[],
    currentLastTradeDay: Date,
  ): Promise<void> {
    if (entries.length === 0) return;
    const rows: BaselineCacheRow[] = entries.map((e) => ({
      key: baselineKey(holding, e.entryDay),
      last_trade_day: currentLastTradeDay,
      mean: e.mean,
      std: e.std,
    }));
    await this.baselineStore.upsertMany(rows);
  }

  /** Flush both stores; called by tests + admin endpoints. */
  async flush(): Promise<void> {
    await Promise.all([this.screenStore.flush(), this.baselineStore.flush()]);
  }
}

// ---- helpers --------------------------------------------------------------

function screenKey(planBaseKey: string, asof: string): string {
  return `${planBaseKey}|${asof}`;
}

function baselineKey(holding: number, entryDay: string): string {
  return `${String(holding)}|${entryDay}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function parseCodes(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const x of parsed) if (typeof x === 'string') out.push(x);
    return out;
  } catch {
    return [];
  }
}

/**
 * Stable identity for "same plan, different asof". Strips the per-day
 * `asof` from screenPlan + universePlan so every weekday in one backtest
 * call collapses onto the same cache prefix.
 *
 * Uses sorted-key JSON so two semantically equal plans hash to the same
 * key regardless of object-literal property order.
 */
export function screenBaseKey(req: {
  readonly screenPlan: Readonly<Record<string, unknown>>;
  readonly universePlan?: Readonly<Record<string, unknown>> | null | undefined;
  readonly rank?: unknown;
}): string {
  const { asof: _planAsof, ...planRest } = req.screenPlan;
  let universeNoAsof: Record<string, unknown> | null = null;
  if (req.universePlan !== null && req.universePlan !== undefined) {
    const { asof: _uniAsof, ...rest } = req.universePlan;
    universeNoAsof = rest;
  }
  return stableStringify({
    plan: planRest,
    universe: universeNoAsof,
    rank: req.rank ?? null,
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record: Record<string, unknown> = { ...value };
  const entries = Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
