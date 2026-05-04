/**
 * Cross-process DTOs for the EQTY workbench surface
 * (modules/07-frontend.md). Each schema is the canonical contract
 * between the NestJS gateway and the web client. Generated proto
 * versions will replace the hand-written ones once the Python services
 * expose them.
 *
 * Scope notes (v1):
 * - No realtime quote stream and no index ticker. The workbench reads
 *   everything from the persisted kline rows; there is no separate
 *   `Quote` endpoint.
 * - Fundamental ratios (P/E, P/B) are deferred — Python doesn't compute
 *   them yet, so the schema does not expose them either.
 */

import { z } from 'zod';

/**
 * GET /api/kline/:code?range=30D|90D|250D
 *
 * Mirrors the persisted Python row in `docs/modules/02-stock-kline.md` §46:
 *   - OHLC are nominal (front-adjusted prices live server-side)
 *   - `volume` is share-count, `turnover` is the CNY notional
 *   - `turnoverRate` is the daily turnover ratio (`成交额 / 流通市值`)
 *   - `ma{5,10,20,60}` are pre-computed by the kline writer
 */
export const KlineBarSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number(),
    turnover: z.number(),
    turnoverRate: z.number(),
    ma5: z.number().nullable(),
    ma10: z.number().nullable(),
    ma20: z.number().nullable(),
    ma60: z.number().nullable(),
  })
  .strict();
export type KlineBar = z.infer<typeof KlineBarSchema>;

/** GET /api/sentiment/:code */
export const SentimentSchema = z
  .object({
    code: z.string(),
    score: z.number(),
    theme: z.string(),
    driver: z.string(),
    target: z.number(),
    rumor: z.string(),
    cachedAt: z.string().datetime({ offset: true }),
    rawLog: z.array(z.string()),
    /**
     * Verbatim plain-text analyst write-up from the web-search step
     * (Python `StockSentiment.result`). Empty string when the cached
     * payload predates the two-step pipeline. The A-2 markdown
     * previewer renders this directly.
     */
    result: z.string(),
  })
  .strict();
export type Sentiment = z.infer<typeof SentimentSchema>;

/**
 * Aggregate (multi-stock) sentiment view-model. Returned by GET/POST
 * `/api/sentiment/analyze_many` — a slim projection of the rich
 * `MarketSentiment` payload the Python service produces.
 *
 * The frontend uses it to label a sector with its dominant themes and
 * top-line trend. Per-stock detail is not duplicated here — UIs that
 * need the single-stock `Sentiment` already have it cached under
 * `['sentiment', code]`.
 */
export const ThemeClusterViewSchema = z
  .object({
    label: z.string(),
    /** number of member codes the cluster covers */
    memberCount: z.number().int().nonnegative(),
    heatScore: z.number(),
    summary: z.string(),
  })
  .strict();
export type ThemeClusterView = z.infer<typeof ThemeClusterViewSchema>;

export const MarketSentimentSchema = z
  .object({
    asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
    windowDays: z.number().int().positive(),
    fetchedAt: z.string().datetime({ offset: true }),
    /** sha-256 of canonical (sorted+deduped) member codes — query key */
    codeHash: z.string(),
    /** the codes the analysis ran on, canonicalised */
    codes: z.array(z.string()),
    themeClusters: z.array(ThemeClusterViewSchema),
    marketTrendSummary: z.string(),
    caveats: z.array(z.string()),
  })
  .strict();
export type MarketSentiment = z.infer<typeof MarketSentimentSchema>;
