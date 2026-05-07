/**
 * Anti-corruption mapper: Python `TaAnalysis` JSON payload (snake_case,
 * Decimal-as-string for prices, ISO datetimes) → the strict
 * `TaAnalysis` view-model declared in `@quant/shared` (camelCase, with
 * `cachedAt` carrying offset).
 *
 * Robustness: every accessor tolerates missing / malformed nested
 * fields. The Python side is the source of truth for shape, but stale
 * cached rows must still render rather than 500-out the controller.
 */

import { TaAnalysisSchema, type TaAnalysis, type TaLevel, type TaTrend } from '@quant/shared';

type RawObject = Readonly<Record<string, unknown>>;

const isObj = (v: unknown): v is RawObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asArr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

const asInt = (v: unknown, fallback: number): number => {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isInteger(n) ? n : fallback;
  }
  return fallback;
};

const asUnitFloat = (v: unknown, fallback: number): number => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.max(0, Math.min(1, v));
  }
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  return fallback;
};

const asLevelStrength = (v: unknown): TaLevel['strength'] => {
  if (v === 'weak' || v === 'medium' || v === 'strong') return v;
  return 'medium';
};

const asTrendDirection = (v: unknown): TaTrend['direction'] => {
  if (v === 'up' || v === 'down' || v === 'sideways') return v;
  return 'sideways';
};

function ensureOffsetIso(s: string): string {
  if (s.length === 0) return new Date().toISOString();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/u.test(s)) return s;
  return `${s}Z`;
}

function mapLevels(raw: unknown): readonly TaLevel[] {
  return asArr(raw)
    .filter(isObj)
    .map((entry): TaLevel | null => {
      const priceRaw = entry['price'];
      const price = typeof priceRaw === 'string' ? priceRaw : '';
      // Skip rows that fail the decimal regex; the schema parse below
      // would otherwise fail the whole response.
      if (!/^-?\d+(\.\d+)?$/u.test(price)) return null;
      return {
        price,
        strength: asLevelStrength(entry['strength']),
        reason: asStr(entry['reason']),
      };
    })
    .filter((x): x is TaLevel => x !== null);
}

function mapTrend(raw: unknown): TaTrend {
  const obj: RawObject = isObj(raw) ? raw : {};
  return {
    direction: asTrendDirection(obj['direction']),
    horizonDays: Math.max(1, asInt(obj['horizon_days'], 5)),
    confidence: asUnitFloat(obj['confidence'], 0),
    rationale: asStr(obj['rationale']),
  };
}

export function mapTaAnalysisToView(raw: unknown): TaAnalysis {
  if (!isObj(raw)) {
    throw new Error('ta payload is not an object');
  }
  const code = asStr(raw['code']);
  const asof = asStr(raw['asof']).slice(0, 10);
  const fetchedAt = asStr(raw['fetched_at']);
  return TaAnalysisSchema.parse({
    code,
    asof,
    barsCount: Math.max(0, asInt(raw['bars_count'], 0)),
    supportLevels: mapLevels(raw['support_levels']),
    resistanceLevels: mapLevels(raw['resistance_levels']),
    trend: mapTrend(raw['trend']),
    patterns: asArr(raw['patterns'])
      .map(asStr)
      .filter((s) => s.length > 0),
    caveats: asArr(raw['caveats'])
      .map(asStr)
      .filter((s) => s.length > 0),
    provider: asStr(raw['provider']),
    cachedAt: ensureOffsetIso(fetchedAt),
  });
}
