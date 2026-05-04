/**
 * Anti-corruption mapper: rich Python `StockSentiment` /
 * `MarketSentiment` JSON payload → slim front-end view-model declared
 * in `@quant/shared`.
 *
 * Why a mapper at all: Python owns a deeply nested domain (insights,
 * themes, research targets, evidence trails). The UI shows a compact
 * card. The view-model lives in the gateway so the browser bundle
 * never ships the full domain schema (CLAUDE.md §2.5.1 — view-models
 * are a separate core asset from the domain).
 *
 * Robustness: every accessor is tolerant — missing or malformed nested
 * fields collapse to `''` / `0` rather than throwing. The Python side
 * is the source of truth for shape, but a partial payload (e.g. when
 * `coverage_gaps` is set) must still render.
 */

import {
  MarketSentimentSchema,
  SentimentSchema,
  type MarketSentiment,
  type Sentiment,
  type ThemeClusterView,
} from '@quant/shared';
import { createHash } from 'node:crypto';

interface RawObject {
  readonly [k: string]: unknown;
}

const isObj = (v: unknown): v is RawObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asArr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

const asNum = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

/**
 * Map a Python `StockSentiment` payload into the slim `Sentiment`
 * view-model the EQTY workbench renders.
 *
 * `sentiment_score ∈ [-1, 1]` is rescaled to `[0, 1]` so the UI's
 * five-star widget works without knowing about negative sentiment.
 */
export function mapStockSentimentToView(raw: unknown): Sentiment {
  if (!isObj(raw)) {
    throw new Error('sentiment payload is not an object');
  }
  const code = asStr(raw['code']);
  const sentimentScore = asNum(raw['sentiment_score']);
  const score = clamp((sentimentScore + 1) / 2, 0, 1);
  const fetchedAt = asStr(raw['fetched_at']);
  const cachedAt = ensureOffsetIso(fetchedAt);

  const themes = asArr(raw['hot_themes']);
  const topTheme = themes.length > 0 && isObj(themes[0]) ? asStr((themes[0] as RawObject)['label']) : '';

  const drivers = asArr(raw['core_drivers']);
  const topDriver = drivers.length > 0 && isObj(drivers[0]) ? asStr((drivers[0] as RawObject)['summary']) : '';

  const research = asArr(raw['research_targets']);
  const targetUpside = research.length > 0 && isObj(research[0])
    ? asNum((research[0] as RawObject)['target_upside_pct'])
    : 0;

  const rumorSource = pickFirstRumor([drivers, asArr(raw['m_and_a'])]);
  const rumor = rumorSource ?? '';

  const rawLog = synthesizeRawLog(raw, { score, topTheme, topDriver, targetUpside });
  const result = asStr(raw['result']);

  return SentimentSchema.parse({
    code,
    score,
    theme: topTheme,
    driver: topDriver,
    target: targetUpside,
    rumor,
    cachedAt,
    rawLog,
    result,
  });
}

/**
 * Map a Python `MarketSentiment` payload into the slim aggregate
 * view-model. Per-stock detail is stripped — UIs that need it already
 * have it cached under the per-stock query key.
 */
export function mapMarketSentimentToView(
  raw: unknown,
  requestedCodes: readonly string[],
): MarketSentiment {
  if (!isObj(raw)) {
    throw new Error('market sentiment payload is not an object');
  }
  const codes = canonicaliseCodes(requestedCodes);
  const codeHash = sha256(codes.join(','));
  const fetchedAt = ensureOffsetIso(asStr(raw['fetched_at']));
  const asof = asStr(raw['asof']).slice(0, 10);
  const windowDaysRaw = asNum(raw['window_days']);
  const windowDays = Number.isInteger(windowDaysRaw) && windowDaysRaw > 0 ? windowDaysRaw : 30;

  const themeClusters: ThemeClusterView[] = asArr(raw['theme_clusters'])
    .filter(isObj)
    .map(
      (cluster): ThemeClusterView => ({
        label: asStr(cluster['theme_label']),
        memberCount: asArr(cluster['member_codes']).length,
        heatScore: asNum(cluster['heat_score']),
        summary: asStr(cluster['summary']),
      }),
    );

  const marketTrend = isObj(raw['market_trend']) ? raw['market_trend'] : {};
  const marketTrendSummary = asStr(marketTrend['summary']);
  const caveats = asArr(raw['caveats']).map(asStr).filter((s) => s.length > 0);

  return MarketSentimentSchema.parse({
    asof,
    windowDays,
    fetchedAt,
    codeHash,
    codes,
    themeClusters,
    marketTrendSummary,
    caveats,
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function pickFirstRumor(buckets: readonly (readonly unknown[])[]): string | null {
  for (const list of buckets) {
    for (const item of list) {
      if (isObj(item) && item['is_rumor'] === true) {
        return asStr(item['summary']);
      }
    }
  }
  return null;
}

function synthesizeRawLog(
  raw: RawObject,
  view: { readonly score: number; readonly topTheme: string; readonly topDriver: string; readonly targetUpside: number },
): readonly string[] {
  const lines: string[] = [];
  lines.push(`▎ source  qwen.web_search → flash.summarise · ${String(asArr(raw['core_drivers']).length)} drivers`);
  if (view.topTheme.length > 0) lines.push(`▎ theme   ${view.topTheme}`);
  if (view.topDriver.length > 0) lines.push(`▎ driver  ${view.topDriver}`);
  if (view.targetUpside !== 0) lines.push(`▎ target  ${view.targetUpside.toFixed(2)}%`);
  lines.push(`▎ score   ${view.score.toFixed(2)} / 1.0`);
  const caveats = asArr(raw['caveats']).map(asStr).filter((s) => s.length > 0);
  for (const c of caveats) lines.push(`! ${c}`);
  return lines;
}

function ensureOffsetIso(s: string): string {
  if (s.length === 0) return new Date().toISOString();
  // Python `datetime.isoformat()` may produce naive ISO without offset.
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return s;
  return `${s}Z`;
}

function canonicaliseCodes(codes: readonly string[]): readonly string[] {
  const set = new Set<string>();
  for (const c of codes) {
    if (typeof c === 'string' && c.length > 0) set.add(c);
  }
  return [...set].sort();
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
