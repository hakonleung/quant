/**
 * Cross-process DTOs for module W-0 watch (`docs/modules/W-0-watch.md`).
 *
 * Single source of truth for both the NestJS WatchModule (storage,
 * scheduler, controller) and the Next.js Watch pane. Python mirrors the
 * shape via its own `pydantic` model — both sides stay in sync because
 * the wire format is restricted to JSON-friendly primitives (strings for
 * Decimal, ISO 8601 for timestamps).
 *
 * Decimals (`thresholdPct`, `thresholdPrice`) are carried as strings to
 * avoid `number` precision loss (CLAUDE.md §2.8). Timestamps are ISO
 * UTC; consumers convert to BJT for display.
 */

import { z } from 'zod';

export const WatchMarketSchema = z.enum(['a', 'hk', 'us']);
export type WatchMarket = z.infer<typeof WatchMarketSchema>;

export const WatchBaselineSchema = z.enum(['prev_close', 'day_high', 'day_low']);
export type WatchBaseline = z.infer<typeof WatchBaselineSchema>;

/**
 * Per-market code shape. Catches the common "I picked market=a but
 * typed an HK code" mistake before the akshare adapter chokes on it
 * with a confusing TypeError.
 *
 *   a  → 6 digits (Shanghai/Shenzhen)
 *   hk → 4–5 digits (HKEX numeric ticker; some 1-digit raw inputs are
 *        rejected on purpose — pad them in the UI)
 *   us → 1–10 letters, optional `.` or `-` in the middle (BRK.B, RDS-A);
 *        also accepts the akshare/东方财富 secid prefix "<digits>."
 *        (e.g. "105.LITE", "106.IBM") that the cached US universe emits.
 */
const CODE_PATTERN: Readonly<Record<WatchMarket, RegExp>> = {
  a: /^\d{6}$/,
  hk: /^\d{4,5}$/,
  us: /^(?:\d{1,3}\.)?[A-Za-z][A-Za-z.\-]{0,9}$/,
};

export function isValidWatchCode(market: WatchMarket, code: string): boolean {
  return CODE_PATTERN[market].test(code);
}

const signedDecimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'expected signed decimal as string');
const positiveDecimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'expected non-negative decimal as string');

export const WatchPctConditionSchema = z
  .object({
    kind: z.literal('pct'),
    baseline: WatchBaselineSchema,
    thresholdPct: signedDecimal.refine((v) => v !== '0' && v !== '-0' && v !== '+0', {
      message: 'thresholdPct must be non-zero',
    }),
  })
  .strict();

export const WatchAbsConditionSchema = z
  .object({
    kind: z.literal('abs'),
    op: z.enum(['gte', 'lte']),
    thresholdPrice: positiveDecimal.refine((v) => Number(v) > 0, {
      message: 'thresholdPrice must be > 0',
    }),
  })
  .strict();

export const WatchConditionSchema = z.discriminatedUnion('kind', [
  WatchPctConditionSchema,
  WatchAbsConditionSchema,
]);
export type WatchCondition = z.infer<typeof WatchConditionSchema>;
export type WatchPctCondition = z.infer<typeof WatchPctConditionSchema>;
export type WatchAbsCondition = z.infer<typeof WatchAbsConditionSchema>;

const isoDateTime = z.string().datetime({ offset: true });

export const WatchTaskSchema = z
  .object({
    market: WatchMarketSchema,
    code: z.string().min(1),
    name: z.string(),
    conditions: z.array(WatchConditionSchema).min(1),
    intervalSec: z.number().int().min(5).default(20),
    pushIntervalSec: z.number().int().min(60).default(300),
    remaining: z.number().int().min(0).nullable().default(null),
    notifySlack: z.boolean().default(true),
    enabled: z.boolean().default(true),
    createdAt: isoDateTime,
    lastTickAt: isoDateTime.nullable().default(null),
    lastPushAt: isoDateTime.nullable().default(null),
    /**
     * Most recent successful quote tick (regardless of match outcome).
     * Distinct from `lastTickAt` (which also bumps on upstream failures);
     * used by the match→hit edge detector to identify the "previous
     * cached price sample".
     */
    lastSampleAt: isoDateTime.nullable().default(null),
    /**
     * Most recent successful tick where any condition matched. The
     * scheduler treats `lastMatchAt === lastSampleAt` (same trading day)
     * as "previous sample already matched" → current match is not a hit.
     */
    lastMatchAt: isoDateTime.nullable().default(null),
    /** Edge-triggered hits — count of not-match → match transitions. */
    hitCount: z.number().int().min(0).default(0),
  })
  .strict();
export type WatchTask = z.infer<typeof WatchTaskSchema>;

export const WatchTaskCreateSchema = z
  .object({
    market: WatchMarketSchema,
    code: z.string().min(1),
    name: z.string(),
    conditions: z.array(WatchConditionSchema).min(1),
    intervalSec: z.number().int().min(5).default(20),
    pushIntervalSec: z.number().int().min(60).default(300),
    remaining: z.number().int().min(0).nullable().default(null),
    notifySlack: z.boolean().default(true),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!isValidWatchCode(data.market, data.code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['code'],
        message: `code ${JSON.stringify(data.code)} does not match market ${data.market} (a=6 digits, hk=4–5 digits, us=letters with optional "<digits>." secid prefix)`,
      });
    }
  });
export type WatchTaskCreate = z.infer<typeof WatchTaskCreateSchema>;

export const WatchTaskPatchSchema = z
  .object({
    name: z.string().optional(),
    conditions: z.array(WatchConditionSchema).min(1).optional(),
    intervalSec: z.number().int().min(5).optional(),
    pushIntervalSec: z.number().int().min(60).optional(),
    remaining: z.number().int().min(0).nullable().optional(),
    notifySlack: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type WatchTaskPatch = z.infer<typeof WatchTaskPatchSchema>;

export const StockBasicSchema = z
  .object({
    market: WatchMarketSchema,
    code: z.string().min(1),
    name: z.string(),
  })
  .strict();
export type StockBasic = z.infer<typeof StockBasicSchema>;

export const SpotQuoteSchema = z
  .object({
    market: WatchMarketSchema,
    code: z.string().min(1),
    last: positiveDecimal,
    dayHigh: positiveDecimal,
    dayLow: positiveDecimal,
    prevClose: positiveDecimal,
    ts: isoDateTime,
  })
  .strict();
export type SpotQuote = z.infer<typeof SpotQuoteSchema>;

export const UniverseRefreshAckSchema = z
  .object({ market: WatchMarketSchema, count: z.number().int().min(0) })
  .strict();
export type UniverseRefreshAck = z.infer<typeof UniverseRefreshAckSchema>;

export function watchTaskKey(market: WatchMarket, code: string): string {
  return `${market}:${code}`;
}
