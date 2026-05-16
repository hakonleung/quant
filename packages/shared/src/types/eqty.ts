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

// ---------------------------------------------------------------------------
// Sentiment (single stock) — multi-dimensional structured analysis.
// Wire-side (LLM output): each array entry is a compact "|"-separated string;
// NestJS parses into the typed sub-records below before reaching FE/IM.
// ---------------------------------------------------------------------------

const SentimentDirectionSchema = z.enum(['positive', 'negative', 'neutral']);
export type SentimentDirection = z.infer<typeof SentimentDirectionSchema>;

export const InsightSchema = z
  .object({
    summary: z.string(),
    direction: SentimentDirectionSchema,
    confidence: z.number().min(0).max(1),
    isRumor: z.boolean(),
  })
  .strict();
export type Insight = z.infer<typeof InsightSchema>;

export const ThemeTagSchema = z
  .object({
    label: z.string(),
    relevance: z.number().min(0).max(1),
    rationale: z.string(),
  })
  .strict();
export type ThemeTag = z.infer<typeof ThemeTagSchema>;

export const ProductInfoSchema = z
  .object({
    name: z.string(),
    revenueSharePct: z.number().nullable(),
    note: z.string().nullable(),
  })
  .strict();
export type ProductInfo = z.infer<typeof ProductInfoSchema>;

const PriceChangeSchema = z.enum(['price_up', 'price_down', 'shortage', 'destock', 'stable']);
export type PriceChange = z.infer<typeof PriceChangeSchema>;

const PriceHorizonSchema = z.enum(['spot', 'short_term', 'mid_term']);
export type PriceHorizon = z.infer<typeof PriceHorizonSchema>;

export const PriceSignalSchema = z
  .object({
    product: z.string(),
    change: PriceChangeSchema,
    horizon: PriceHorizonSchema,
    magnitude: z.string().nullable(),
  })
  .strict();
export type PriceSignal = z.infer<typeof PriceSignalSchema>;

export const ResearchTargetSchema = z
  .object({
    broker: z.string(),
    rating: z.string().nullable(),
    targetPrice: z.number().nullable(),
    targetUpsidePct: z.number().nullable(),
    horizonMonths: z.number().int().nullable(),
    reportDate: z.string().nullable(),
  })
  .strict();
export type ResearchTarget = z.infer<typeof ResearchTargetSchema>;

const CompetitorRelationSchema = z.enum([
  'domestic_peer',
  'foreign_peer',
  'substitute',
  'upstream',
  'downstream',
]);
export type CompetitorRelation = z.infer<typeof CompetitorRelationSchema>;

const ThreatLevelSchema = z.enum(['high', 'medium', 'low']);
export type ThreatLevel = z.infer<typeof ThreatLevelSchema>;

export const CompetitorSchema = z
  .object({
    name: z.string(),
    relation: CompetitorRelationSchema,
    threatLevel: ThreatLevelSchema,
    note: z.string(),
  })
  .strict();
export type Competitor = z.infer<typeof CompetitorSchema>;

const MarketPositionSchema = z.enum(['leader', 'challenger', 'follower', 'niche', 'unclear']);
export type MarketPosition = z.infer<typeof MarketPositionSchema>;

export const CompetitiveLandscapeSchema = z
  .object({
    marketPosition: MarketPositionSchema,
    marketSharePct: z.number().nullable(),
    summary: z.string(),
    competitors: z.array(CompetitorSchema),
    moats: z.array(z.string()),
    risks: z.array(z.string()),
  })
  .strict();
export type CompetitiveLandscape = z.infer<typeof CompetitiveLandscapeSchema>;

/** GET /api/sentiment/:code — structured multi-dimensional sentiment. */
export const SentimentSchema = z
  .object({
    code: z.string(),
    cachedAt: z.string().datetime({ offset: true }),
    /** One-paragraph "上涨核心动因分析" (≤120字), brief view. */
    brief: z.string(),
    /** Normalised [0,1] sentiment score (derived from raw [-1,1]). */
    score: z.number().min(0).max(1),
    coreDrivers: z.array(InsightSchema),
    hotThemes: z.array(ThemeTagSchema),
    coreProducts: z.array(ProductInfoSchema),
    priceSignals: z.array(PriceSignalSchema),
    mAndA: z.array(InsightSchema),
    supplyDemand: z.array(InsightSchema),
    researchTargets: z.array(ResearchTargetSchema),
    competitiveLandscape: CompetitiveLandscapeSchema.nullable(),
    coverageGaps: z.array(z.string()),
    caveats: z.array(z.string()),
  })
  .strict();
export type Sentiment = z.infer<typeof SentimentSchema>;

// ---------------------------------------------------------------------------
// Market (multi-stock) sentiment.
// ---------------------------------------------------------------------------

const ClusterTrendSchema = z.enum(['rising', 'stable', 'fading']);
export type ClusterTrend = z.infer<typeof ClusterTrendSchema>;

export const ThemeClusterViewSchema = z
  .object({
    label: z.string(),
    memberCodes: z.array(z.string()),
    relatedIndustries: z.array(z.string()),
    heatScore: z.number(),
    trend: ClusterTrendSchema,
    summary: z.string(),
  })
  .strict();
export type ThemeClusterView = z.infer<typeof ThemeClusterViewSchema>;

const StyleSignalNameSchema = z.enum([
  'growth_over_value',
  'value_over_growth',
  'large_cap_outperform',
  'small_cap_outperform',
  'defensive_over_offensive',
  'offensive_over_defensive',
  'high_beta',
  'low_beta',
]);
export type StyleSignalName = z.infer<typeof StyleSignalNameSchema>;

export const StyleSignalSchema = z
  .object({
    name: StyleSignalNameSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  })
  .strict();
export type StyleSignal = z.infer<typeof StyleSignalSchema>;

const IndustryDirectionSchema = z.enum(['improving', 'stable', 'deteriorating']);
export type IndustryDirection = z.infer<typeof IndustryDirectionSchema>;

export const IndustryTrendSchema = z
  .object({
    industry: z.string(),
    summary: z.string(),
    direction: IndustryDirectionSchema,
    drivers: z.array(z.string()),
    risks: z.array(z.string()),
    relatedThemes: z.array(z.string()),
  })
  .strict();
export type IndustryTrend = z.infer<typeof IndustryTrendSchema>;

export const MarketSentimentSchema = z
  .object({
    asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
    windowDays: z.number().int().positive(),
    fetchedAt: z.string().datetime({ offset: true }),
    /** sha-256 of canonical (sorted+deduped) member codes — query key */
    codeHash: z.string(),
    codes: z.array(z.string()),
    /** One-paragraph 市场综述 (≤120字), brief view. */
    brief: z.string(),
    themeClusters: z.array(ThemeClusterViewSchema),
    styleSignals: z.array(StyleSignalSchema),
    industryTrends: z.array(IndustryTrendSchema),
    caveats: z.array(z.string()),
  })
  .strict();
export type MarketSentiment = z.infer<typeof MarketSentimentSchema>;
