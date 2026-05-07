/**
 * Configuration-driven registry of data actions.
 *
 * Action *configs* are pure (CLAUDE.md §2.5.1) — they describe what each
 * action takes / returns / caches, but contain no fetch logic. The Mock and
 * Live runners attach behavior on top.
 */

import { TaAnalysisSchema, type TaAnalysis } from '@quant/shared';
import { z } from 'zod';
import type { DataActionConfig } from './types.js';

/* ---------- shared schemas ---------- */

const codeSchema = z.string().regex(/^\d{6}$/u, '6-digit code expected');
const codesSchema = z.array(codeSchema).max(500);

/**
 * Watch tasks span A / HK / US markets — the per-market code patterns
 * (6-digit / 4–5-digit / letters±secid prefix) live in `@quant/shared`
 * `isValidWatchCode`. The terminal action layer relaxes to "any non-
 * empty string"; strict per-market validation happens server-side in
 * `WatchTaskCreate.superRefine`. This avoids an action-level reject
 * when the user enters a 4-digit HK code.
 */
const watchCodeSchema = z.string().min(1);

const stockMetaSchema = z.object({
  code: codeSchema,
  name: z.string(),
  pinyin: z.string().optional(),
  industry: z.string().nullable().optional(),
  market: z.enum(['a', 'hk', 'us']).default('a'),
});
export type StockMeta = z.infer<typeof stockMetaSchema>;

const klineBarSchema = z.object({
  date: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().nonnegative(),
});
export type KlineBar = z.infer<typeof klineBarSchema>;

const stockSnapshotSchema = z.object({
  code: codeSchema,
  price: z.number().nullable(),
  asof: z.string().nullable(),
  pe_ttm: z.number().nullable().optional(),
  pb: z.number().nullable().optional(),
  mkt_cap: z.number().nullable().optional(),
});
export type StockSnapshot = z.infer<typeof stockSnapshotSchema>;

const sectorSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['user', 'dynamic']),
  count: z.number().int().nonnegative(),
  meta: z.string().default(''),
  chgPct: z.number().nullable().default(null),
  codes: z.array(codeSchema),
  nl: z.string().optional(),
  evidence: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
export type Sector = z.infer<typeof sectorSchema>;

const sentimentSchema = z.object({
  code: codeSchema,
  score: z.number().min(-1).max(1),
  theme: z.string(),
  driver: z.string().nullable(),
  cachedAt: z.string(),
});
export type Sentiment = z.infer<typeof sentimentSchema>;

const marketSentimentSchema = z.object({
  codes: z.array(codeSchema),
  score: z.number().min(-1).max(1),
  themes: z.array(z.string()),
  cachedAt: z.string(),
});
export type MarketSentiment = z.infer<typeof marketSentimentSchema>;

const watchBaselineSchema = z.enum(['prev_close', 'day_high', 'day_low', 'vwap', 'trend']);
export type WatchBaseline = z.infer<typeof watchBaselineSchema>;

const watchOpSchema = z.enum(['gte', 'lte']);
export type WatchOp = z.infer<typeof watchOpSchema>;

const watchPctConditionSchema = z
  .object({
    kind: z.literal('pct'),
    baseline: watchBaselineSchema,
    op: watchOpSchema,
    /** Decimal-as-string, signed. Non-zero. */
    thresholdPct: z.string().regex(/^-?\d+(\.\d+)?$/u),
    /** Required iff `baseline === 'trend'`; lookback in **seconds**. */
    window: z
      .number()
      .int()
      .min(1)
      .max(4 * 60 * 60)
      .optional(),
  })
  .strict();

const watchAbsConditionSchema = z
  .object({
    kind: z.literal('abs'),
    op: watchOpSchema,
    /** Decimal-as-string, positive. */
    thresholdPrice: z.string().regex(/^\d+(\.\d+)?$/u),
  })
  .strict();

const watchConditionSchema = z.discriminatedUnion('kind', [
  watchPctConditionSchema,
  watchAbsConditionSchema,
]);
export type WatchCondition = z.infer<typeof watchConditionSchema>;

const watchTaskSchema = z.object({
  market: z.enum(['a', 'hk', 'us']),
  code: watchCodeSchema,
  name: z.string(),
  conditions: z.array(watchConditionSchema).min(1),
  /** Polling interval in seconds (display unit on the form is minutes). */
  intervalSec: z.number().int().min(5).default(60),
  /** Min seconds between push notifications (display unit is minutes). */
  pushIntervalSec: z.number().int().min(60).default(300),
  enabled: z.boolean().default(true),
  hitCount: z.number().int().nonnegative().default(0),
});
export type WatchTask = z.infer<typeof watchTaskSchema>;

const screenResultSchema = z.object({
  nl: z.string(),
  matches: z.array(
    z.object({
      code: codeSchema,
      name: z.string(),
      score: z.number().nullable().optional(),
    }),
  ),
  dslSummary: z.string(),
});
export type ScreenResult = z.infer<typeof screenResultSchema>;

/* ---------- action configs ---------- */

export const stockListAction: DataActionConfig<Record<string, never>, readonly StockMeta[]> = {
  id: 'stock.list',
  kind: 'read',
  summary: 'List the full stock universe (cached for completion + search).',
  args: z.object({}).strict(),
  result: z.array(stockMetaSchema),
  cacheKey: () => ['stock.list'],
};

export const stockInfoAction: DataActionConfig<{ code: string }, StockMeta> = {
  id: 'stock.info',
  kind: 'read',
  summary: 'Get one stock by code.',
  args: z.object({ code: codeSchema }),
  result: stockMetaSchema,
  cacheKey: (a) => ['stock.info', a.code],
};

export const stockKlineAction: DataActionConfig<
  { code: string; range: string },
  readonly KlineBar[]
> = {
  id: 'stock.kline',
  kind: 'read',
  summary: 'List kline bars for a stock.',
  args: z.object({ code: codeSchema, range: z.enum(['30D', '90D', '250D']).default('90D') }),
  result: z.array(klineBarSchema),
  cacheKey: (a) => ['stock.kline', a.code, a.range],
};

export const stockSnapshotsAction: DataActionConfig<
  { codes: readonly string[] },
  readonly StockSnapshot[]
> = {
  id: 'stock.snapshots',
  kind: 'read',
  summary: 'Snapshot prices for a batch of codes.',
  args: z.object({ codes: codesSchema }),
  result: z.array(stockSnapshotSchema),
  cacheKey: (a) => ['stock.snapshots', [...a.codes].sort().join(',')],
};

export const sectorListAction: DataActionConfig<Record<string, never>, readonly Sector[]> = {
  id: 'sector.list',
  kind: 'read',
  summary: 'List user-defined and dynamic sectors.',
  args: z.object({}).strict(),
  result: z.array(sectorSchema),
  cacheKey: () => ['sector.list'],
};

export const sectorShowAction: DataActionConfig<{ idOrName: string }, Sector> = {
  id: 'sector.show',
  kind: 'read',
  summary: 'Get one sector by id or name.',
  args: z.object({ idOrName: z.string().min(1) }),
  result: sectorSchema,
  cacheKey: (a) => ['sector.show', a.idOrName],
};

export const sectorUpsertAction: DataActionConfig<{ sector: Sector }, Sector> = {
  id: 'sector.upsert',
  kind: 'write',
  summary: 'Create or update a sector.',
  args: z.object({ sector: sectorSchema }),
  result: sectorSchema,
  invalidates: () => [['sector.list'], ['sector.show']],
};

export const sectorRemoveAction: DataActionConfig<{ idOrName: string }, { idOrName: string }> = {
  id: 'sector.remove',
  kind: 'write',
  summary: 'Delete a sector by id or name.',
  args: z.object({ idOrName: z.string().min(1) }),
  result: z.object({ idOrName: z.string() }),
  invalidates: () => [['sector.list'], ['sector.show']],
};

export const sectorRefreshDynamicAction: DataActionConfig<{ idOrName: string }, Sector> = {
  id: 'sector.refreshDynamic',
  kind: 'write',
  summary: 'Re-run a dynamic sector NL screen and refresh codes.',
  args: z.object({ idOrName: z.string().min(1) }),
  result: sectorSchema,
  invalidates: () => [['sector.list'], ['sector.show']],
};

export const analyzeOneAction: DataActionConfig<{ code: string; force?: boolean }, Sentiment> = {
  id: 'analyze.one',
  kind: 'paid',
  summary: 'Single-stock LLM sentiment analysis.',
  args: z.object({ code: codeSchema, force: z.boolean().optional() }),
  result: sentimentSchema,
  cacheKey: (a) => ['analyze.one', a.code],
  invalidates: (a) => [['analyze.one', a.code]],
};

export const analyzeManyAction: DataActionConfig<
  { codes: readonly string[]; force?: boolean },
  MarketSentiment
> = {
  id: 'analyze.many',
  kind: 'paid',
  summary: 'Aggregate LLM sentiment for a basket.',
  args: z.object({ codes: codesSchema, force: z.boolean().optional() }),
  result: marketSentimentSchema,
  cacheKey: (a) => ['analyze.many', [...a.codes].sort().join(',')],
  invalidates: (a) => [['analyze.many', [...a.codes].sort().join(',')]],
};

export const analyzeTaAction: DataActionConfig<{ code: string; force?: boolean }, TaAnalysis> = {
  id: 'analyze.ta',
  kind: 'paid',
  summary: 'Single-stock 90D price/volume technical analysis (LLM, Kimi Pro).',
  args: z.object({ code: codeSchema, force: z.boolean().optional() }),
  result: TaAnalysisSchema,
  cacheKey: (a) => ['analyze.ta', a.code],
  invalidates: (a) => [['analyze.ta', a.code]],
};

export const screenNlAction: DataActionConfig<{ nl: string; asof?: string }, ScreenResult> = {
  id: 'screen.nl',
  kind: 'paid',
  summary: 'Run an NL → DSL → screen pipeline.',
  args: z.object({ nl: z.string().min(1), asof: z.string().optional() }),
  result: screenResultSchema,
  cacheKey: (a) => ['screen.nl', a.nl, a.asof ?? ''],
};

export const watchListAction: DataActionConfig<Record<string, never>, readonly WatchTask[]> = {
  id: 'watch.list',
  kind: 'read',
  summary: 'List active watch tasks.',
  args: z.object({}).strict(),
  result: z.array(watchTaskSchema),
  cacheKey: () => ['watch.list'],
};

export const watchUpsertAction: DataActionConfig<{ task: WatchTask }, WatchTask> = {
  id: 'watch.upsert',
  kind: 'write',
  summary: 'Create or update a watch task.',
  args: z.object({ task: watchTaskSchema }),
  result: watchTaskSchema,
  invalidates: () => [['watch.list']],
};

export const watchRemoveAction: DataActionConfig<
  { market: 'a' | 'hk' | 'us'; code: string },
  { market: string; code: string }
> = {
  id: 'watch.remove',
  kind: 'write',
  summary: 'Delete one watch task.',
  args: z.object({ market: z.enum(['a', 'hk', 'us']), code: watchCodeSchema }),
  result: z.object({ market: z.string(), code: z.string() }),
  invalidates: () => [['watch.list']],
};

export const ALL_ACTIONS = [
  stockListAction,
  stockInfoAction,
  stockKlineAction,
  stockSnapshotsAction,
  sectorListAction,
  sectorShowAction,
  sectorUpsertAction,
  sectorRemoveAction,
  sectorRefreshDynamicAction,
  analyzeOneAction,
  analyzeManyAction,
  analyzeTaAction,
  screenNlAction,
  watchListAction,
  watchUpsertAction,
  watchRemoveAction,
] as const;

const byId = new Map<string, DataActionConfig<unknown, unknown>>();
for (const a of ALL_ACTIONS) {
  if (byId.has(a.id)) {
    throw new Error(`duplicate action id: ${a.id}`);
  }
  byId.set(a.id, a as unknown as DataActionConfig<unknown, unknown>);
}

export function findAction(id: string): DataActionConfig<unknown, unknown> | undefined {
  return byId.get(id);
}

export function listActions(): readonly DataActionConfig<unknown, unknown>[] {
  return ALL_ACTIONS as readonly DataActionConfig<unknown, unknown>[];
}
