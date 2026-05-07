/**
 * Cross-process DTOs for module W-0 watch (`docs/modules/06-watch.md`).
 *
 * Single source of truth for both the NestJS WatchModule (storage,
 * scheduler, controller) and the Next.js Watch pane. Python mirrors the
 * shape via its own `pydantic` model — both sides stay in sync because
 * the wire format is restricted to JSON-friendly primitives (strings for
 * Decimal, ISO 8601 for timestamps).
 *
 * Decimals (`thresholdPct`, `thresholdPrice`, `amount`, `volume`,
 * `lastHitPrice`) are carried as strings to avoid `number` precision
 * loss (CLAUDE.md §2.8). Timestamps are ISO UTC; consumers convert to
 * BJT for display.
 */

import { z } from 'zod';

export const WatchMarketSchema = z.enum(['a', 'hk', 'us']);
export type WatchMarket = z.infer<typeof WatchMarketSchema>;

/**
 * Reference price the `pct` condition compares the current price against.
 *
 * - `prev_close` / `day_high` / `day_low` come from the quote.
 * - `vwap`  — volume-weighted-average price = `amount / volume` of the
 *   latest quote tick (intraday cumulative).
 * - `trend` — the cached `last` price whose timestamp is closest to
 *   `<latest sample's ts> - <window seconds>` (and at or before that
 *   cutoff). Requires the condition's `window` field (in **seconds**).
 *   If no cached sample old enough to satisfy the cutoff exists, the
 *   condition does NOT fire (returns null baseline).
 */
export const WatchBaselineSchema = z.enum(['prev_close', 'day_high', 'day_low', 'vwap', 'trend']);
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

/**
 * Hard cap on the `trend` baseline window — in **seconds**. 4 hours
 * comfortably covers a full A-share / HK / US session. Keeps the
 * in-memory sample buffer bounded by a wall-clock window the scheduler
 * can trim against.
 */
export const WATCH_TREND_WINDOW_MAX_SEC = 4 * 60 * 60;

/**
 * Comparison: `(last - baseline) / baseline` (in %) `op` `thresholdPct`.
 *
 * `op === 'gte'` fires when the delta meets or exceeds the threshold;
 * `op === 'lte'` fires when the delta is at or below it. The threshold
 * itself is signed — negative thresholds are useful when paired with
 * `lte` to express drops (e.g. `-3% lte` ≡ "down at least 3%").
 *
 * `window` is required when `baseline === 'trend'` and forbidden
 * otherwise; the runtime check sits on the union schema below so the
 * discriminated `kind` narrowing still works end-to-end.
 */
export const WatchPctConditionSchema = z
  .object({
    kind: z.literal('pct'),
    baseline: WatchBaselineSchema,
    op: z.enum(['gte', 'lte']),
    thresholdPct: signedDecimal.refine((v) => v !== '0' && v !== '-0' && v !== '+0', {
      message: 'thresholdPct must be non-zero',
    }),
    /** Required iff `baseline === 'trend'`; lookback in **seconds**. */
    window: z.number().int().min(1).max(WATCH_TREND_WINDOW_MAX_SEC).optional(),
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

export const WatchConditionSchema = z
  .discriminatedUnion('kind', [WatchPctConditionSchema, WatchAbsConditionSchema])
  .superRefine((c, ctx) => {
    if (c.kind !== 'pct') return;
    if (c.baseline === 'trend' && c.window === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['window'],
        message: 'window required when baseline is "trend"',
      });
    }
    if (c.baseline !== 'trend' && c.window !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['window'],
        message: 'window only valid when baseline is "trend"',
      });
    }
  });
export type WatchCondition = z.infer<typeof WatchConditionSchema>;
export type WatchPctCondition = z.infer<typeof WatchPctConditionSchema>;
export type WatchAbsCondition = z.infer<typeof WatchAbsConditionSchema>;

const isoDateTime = z.string().datetime({ offset: true });

/**
 * Group name constraints. Names are user-facing identifiers and act as
 * the primary key for `WatchGroup` plus the foreign key on `WatchTask`.
 * Limited to a kebab-friendly charset so they fit in URL path segments
 * (the `DELETE /watch/groups/:name` route) without escaping.
 */
export const WATCH_GROUP_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9 _-]{0,31}$/;
export const WatchGroupNameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(WATCH_GROUP_NAME_PATTERN, {
    message: 'group name must be 1–32 chars; letters/digits/space/_/-, no leading space',
  });

export const WatchGroupSchema = z
  .object({
    name: WatchGroupNameSchema,
    conditions: z.array(WatchConditionSchema).min(1),
    intervalSec: z.number().int().min(5).default(20),
    pushIntervalSec: z.number().int().min(60).default(300),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type WatchGroup = z.infer<typeof WatchGroupSchema>;

export const WatchGroupCreateSchema = z
  .object({
    name: WatchGroupNameSchema,
    conditions: z.array(WatchConditionSchema).min(1),
    intervalSec: z.number().int().min(5).default(20),
    pushIntervalSec: z.number().int().min(60).default(300),
  })
  .strict();
export type WatchGroupCreate = z.infer<typeof WatchGroupCreateSchema>;

export const WatchTaskSchema = z
  .object({
    market: WatchMarketSchema,
    code: z.string().min(1),
    name: z.string(),
    groupName: WatchGroupNameSchema,
    conditions: z.array(WatchConditionSchema).min(1),
    intervalSec: z.number().int().min(5).default(20),
    /**
     * Minimum seconds between two notifications for this task. Combined
     * with the price-delta gate (`±2 %` from `lastHitPrice`) — both must
     * clear for a hit to fire.
     */
    pushIntervalSec: z.number().int().min(60).default(300),
    remaining: z.number().int().min(0).nullable().default(null),
    notifySlack: z.boolean().default(true),
    enabled: z.boolean().default(true),
    createdAt: isoDateTime,
    lastTickAt: isoDateTime.nullable().default(null),
    lastPushAt: isoDateTime.nullable().default(null),
    /** Most recent successful quote tick (regardless of match outcome). */
    lastSampleAt: isoDateTime.nullable().default(null),
    /** Hit counter; bumped on every fired hit. */
    hitCount: z.number().int().min(0).default(0),
    /**
     * `last` price at the most recent fired hit. The price gate
     * suppresses a new hit unless `|currentLast - lastHitPrice| /
     * lastHitPrice` is at least 2 %. Reset to `null` on trading-day
     * rollover. Combined with `pushIntervalSec` time gate.
     */
    lastHitPrice: positiveDecimal.nullable().default(null),
  })
  .strict();
export type WatchTask = z.infer<typeof WatchTaskSchema>;

/**
 * Task create payload. The server is the source of truth for a task's
 * `conditions / intervalSec / pushIntervalSec`: those are owned by the
 * referenced `WatchGroup`. The client only sends `groupName`; the group
 * must already exist (create the group via `POST /watch/groups` first).
 */
export const WatchTaskCreateSchema = z
  .object({
    market: WatchMarketSchema,
    code: z.string().min(1),
    name: z.string(),
    groupName: WatchGroupNameSchema,
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

/**
 * Group-owned fields (`conditions / intervalSec / pushIntervalSec`) are
 * not patchable on a task — change them on the group instead.
 */
export const WatchTaskPatchSchema = z
  .object({
    name: z.string().optional(),
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
    /**
     * Cumulative session traded notional (in market currency units).
     * Required for the `vwap` baseline (`vwap = amount / volume`).
     * Source-side may report 0 before the open auction completes.
     */
    amount: positiveDecimal,
    /**
     * Cumulative session traded volume (shares for A / HK, shares for
     * US). Same caveat as `amount` re: pre-open zero values; consumers
     * must guard against `volume <= 0` before computing `vwap`.
     */
    volume: positiveDecimal,
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
