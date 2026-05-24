/**
 * Pure parsers for the sentiment LLM minimal-string wire format.
 *
 * Each schema field arrives as a `string[]` where every entry is a
 * compact `"|"`-separated record (see `sentiment.prompt.ts` schema
 * documentation). These functions decode each entry into its typed
 * counterpart from `@quant/shared`. Unknown/malformed entries are
 * dropped silently — the prompt forbids them, and the upstream caller
 * tolerates partial coverage rather than retrying.
 *
 * Pure: no IO, no logger, no clock. Safe to unit-test without mocks.
 */

import {
  type CompetitiveLandscape,
  type Competitor,
  type CompetitorRelation,
  type IndustryDirection,
  type IndustryTrend,
  type Insight,
  type MarketPosition,
  type PriceChange,
  type PriceHorizon,
  type PriceSignal,
  type ProductInfo,
  type ResearchTarget,
  type StyleSignal,
  type StyleSignalName,
  type ThemeClusterView,
  type ThemeTag,
  type ThreatLevel,
} from '@quant/shared';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function splitPipe(raw: unknown, expected: number): string[] | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('|').map((s) => s.trim());
  if (parts.length < expected) return null;
  return parts;
}

export function parseNumOrNull(s: string): number | null {
  if (s.length === 0) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseIntOrNull(s: string): number | null {
  const n = parseNumOrNull(s);
  return n === null ? null : Math.trunc(n);
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function parseDirection(s: string): 'positive' | 'negative' | 'neutral' {
  const t = s.toLowerCase();
  if (t === '+' || t === 'positive' || t === 'up' || t === 'pos') return 'positive';
  if (t === '-' || t === 'negative' || t === 'down' || t === 'neg') return 'negative';
  return 'neutral';
}

function parseBoolFlag(s: string): boolean {
  const t = s.toLowerCase();
  return t === '1' || t === 'true' || t === 'yes';
}

// ---------------------------------------------------------------------------
// per-field parsers
// ---------------------------------------------------------------------------

/** `summary|+/-/0|conf|rumor` */
export function parseInsightLine(raw: unknown): Insight | null {
  const parts = splitPipe(raw, 4);
  if (parts === null) return null;
  const summary = parts[0] ?? '';
  if (summary.length === 0) return null;
  const conf = parseNumOrNull(parts[2] ?? '');
  return {
    summary,
    direction: parseDirection(parts[1] ?? ''),
    confidence: clamp01(conf ?? 0),
    isRumor: parseBoolFlag(parts[3] ?? ''),
  };
}

/** `label|relevance|rationale` */
export function parseThemeTagLine(raw: unknown): ThemeTag | null {
  const parts = splitPipe(raw, 3);
  if (parts === null) return null;
  const label = parts[0] ?? '';
  if (label.length === 0) return null;
  const rel = parseNumOrNull(parts[1] ?? '');
  return {
    label,
    relevance: clamp01(rel ?? 0),
    rationale: parts[2] ?? '',
  };
}

/** `name|sharePct|note` */
export function parseProductLine(raw: unknown): ProductInfo | null {
  const parts = splitPipe(raw, 3);
  if (parts === null) return null;
  const name = parts[0] ?? '';
  if (name.length === 0) return null;
  const note = parts[2] ?? '';
  return {
    name,
    revenueSharePct: parseNumOrNull(parts[1] ?? ''),
    note: note.length === 0 ? null : note,
  };
}

const PRICE_CHANGE_MAP: Readonly<Record<string, PriceChange>> = {
  up: 'price_up',
  price_up: 'price_up',
  down: 'price_down',
  price_down: 'price_down',
  shortage: 'shortage',
  destock: 'destock',
  stable: 'stable',
};

const PRICE_HORIZON_MAP: Readonly<Record<string, PriceHorizon>> = {
  spot: 'spot',
  short: 'short_term',
  short_term: 'short_term',
  mid: 'mid_term',
  mid_term: 'mid_term',
};

/** `product|change|horizon|magnitude` */
export function parsePriceSignalLine(raw: unknown): PriceSignal | null {
  const parts = splitPipe(raw, 4);
  if (parts === null) return null;
  const product = parts[0] ?? '';
  if (product.length === 0) return null;
  const change = PRICE_CHANGE_MAP[(parts[1] ?? '').toLowerCase()];
  const horizon = PRICE_HORIZON_MAP[(parts[2] ?? '').toLowerCase()];
  if (change === undefined || horizon === undefined) return null;
  const mag = parts[3] ?? '';
  return {
    product,
    change,
    horizon,
    magnitude: mag.length === 0 ? null : mag,
  };
}

/** `broker|rating|targetPrice|upsidePct|horizonMonths|reportDate` */
export function parseResearchTargetLine(raw: unknown): ResearchTarget | null {
  const parts = splitPipe(raw, 6);
  if (parts === null) return null;
  const broker = parts[0] ?? '';
  if (broker.length === 0) return null;
  const rating = parts[1] ?? '';
  const date = parts[5] ?? '';
  return {
    broker,
    rating: rating.length === 0 ? null : rating,
    targetPrice: parseNumOrNull(parts[2] ?? ''),
    targetUpsidePct: parseNumOrNull(parts[3] ?? ''),
    horizonMonths: parseIntOrNull(parts[4] ?? ''),
    reportDate: /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : null,
  };
}

const RELATION_SET: ReadonlySet<CompetitorRelation> = new Set([
  'domestic_peer',
  'foreign_peer',
  'substitute',
  'upstream',
  'downstream',
]);
const THREAT_SET: ReadonlySet<ThreatLevel> = new Set(['high', 'medium', 'low']);

/** `name|relation|threat|note` */
export function parseCompetitorLine(raw: unknown): Competitor | null {
  const parts = splitPipe(raw, 4);
  if (parts === null) return null;
  const name = parts[0] ?? '';
  if (name.length === 0) return null;
  const relation = parts[1] ?? '';
  const threat = parts[2] ?? '';
  if (!RELATION_SET.has(relation as CompetitorRelation)) return null;
  if (!THREAT_SET.has(threat as ThreatLevel)) return null;
  return {
    name,
    relation: relation as CompetitorRelation,
    threatLevel: threat as ThreatLevel,
    note: parts[3] ?? '',
  };
}

const POSITION_SET: ReadonlySet<MarketPosition> = new Set([
  'leader',
  'challenger',
  'follower',
  'niche',
  'unclear',
]);

export function parseCompetitive(raw: unknown): CompetitiveLandscape | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Readonly<Record<string, unknown>>;
  const pos = typeof obj['pos'] === 'string' ? obj['pos'] : 'unclear';
  const position: MarketPosition = POSITION_SET.has(pos as MarketPosition)
    ? (pos as MarketPosition)
    : 'unclear';
  const share = typeof obj['share'] === 'number' && Number.isFinite(obj['share']) ? obj['share'] : null;
  const competitorsRaw = Array.isArray(obj['competitors']) ? obj['competitors'] : [];
  const competitors = competitorsRaw
    .map(parseCompetitorLine)
    .filter((c): c is Competitor => c !== null);
  return {
    marketPosition: position,
    marketSharePct: share,
    summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
    competitors,
    moats: collectStrings(obj['moats']),
    risks: collectStrings(obj['risks']),
  };
}

const STYLE_NAME_SET: ReadonlySet<StyleSignalName> = new Set([
  'growth_over_value',
  'value_over_growth',
  'large_cap_outperform',
  'small_cap_outperform',
  'defensive_over_offensive',
  'offensive_over_defensive',
  'high_beta',
  'low_beta',
]);

/** `name|confidence|rationale` */
export function parseStyleSignalLine(raw: unknown): StyleSignal | null {
  const parts = splitPipe(raw, 3);
  if (parts === null) return null;
  const name = parts[0] ?? '';
  if (!STYLE_NAME_SET.has(name as StyleSignalName)) return null;
  const conf = parseNumOrNull(parts[1] ?? '');
  return {
    name: name as StyleSignalName,
    confidence: clamp01(conf ?? 0),
    rationale: parts[2] ?? '',
  };
}

const INDUSTRY_DIR_SET: ReadonlySet<IndustryDirection> = new Set([
  'improving',
  'stable',
  'deteriorating',
]);

/** `industry|summary|direction|drivers|risks|relatedThemes`
 *  drivers/risks/relatedThemes are `;`-separated inside the field. */
export function parseIndustryTrendLine(raw: unknown): IndustryTrend | null {
  const parts = splitPipe(raw, 6);
  if (parts === null) return null;
  const industry = parts[0] ?? '';
  if (industry.length === 0) return null;
  const direction = parts[2] ?? '';
  if (!INDUSTRY_DIR_SET.has(direction as IndustryDirection)) return null;
  return {
    industry,
    summary: parts[1] ?? '',
    direction: direction as IndustryDirection,
    drivers: splitSemi(parts[3] ?? ''),
    risks: splitSemi(parts[4] ?? ''),
    relatedThemes: splitSemi(parts[5] ?? ''),
  };
}

const CLUSTER_TREND_SET: ReadonlySet<ThemeClusterView['trend']> = new Set([
  'rising',
  'stable',
  'fading',
]);

export function parseClusterObject(raw: unknown): ThemeClusterView | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Readonly<Record<string, unknown>>;
  const label = typeof obj['label'] === 'string' ? obj['label'] : '';
  if (label.length === 0) return null;
  const members = collectStrings(obj['members']).filter((c) => c.length > 0);
  const heat = typeof obj['heat'] === 'number' && Number.isFinite(obj['heat']) ? obj['heat'] : 0;
  const trendRaw = typeof obj['trend'] === 'string' ? obj['trend'] : 'stable';
  const trend = CLUSTER_TREND_SET.has(trendRaw as ThemeClusterView['trend'])
    ? (trendRaw as ThemeClusterView['trend'])
    : 'stable';
  return {
    label,
    memberCodes: members,
    relatedIndustries: collectStrings(obj['industries']),
    heatScore: heat,
    trend,
    summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
  };
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

export function collectStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) if (typeof v === 'string' && v.length > 0) out.push(v);
  return out;
}

function splitSemi(s: string): string[] {
  if (s.length === 0) return [];
  return s
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function parseJsonObject(raw: string): Readonly<Record<string, unknown>> | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  return payload as Readonly<Record<string, unknown>>;
}
