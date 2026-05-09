/**
 * Pure JSON → `TaAnalysis` decoder. Port of the Python
 * `_build_ta_analysis` + `_decode_*` helpers in
 * `services/py/quant_core/services/ta_service.py`. Tolerates malformed
 * sub-fields (skips bad rows) but throws `LLM_FAILED` when the trend
 * object is missing or unparseable, since downstream consumers expect
 * `trend.direction` to always exist.
 *
 * Output shape is the **wire camelCase** `TaAnalysis` from
 * `@quant/shared`, not the Python snake_case payload — the existing
 * `payload-mapper.ts` is reserved for already-cached Python payloads;
 * fresh LLM output goes through this decoder instead.
 */

import { QuantError, TaAnalysisSchema, type TaAnalysis, type TaLevel, type TaTrend } from '@quant/shared';

const LEVEL_STRENGTHS = new Set<string>(['weak', 'medium', 'strong']);
const TREND_DIRECTIONS = new Set<string>(['up', 'down', 'sideways']);
const MAX_LEVELS = 5;
const MAX_PATTERNS = 8;

const FENCE_RE = /^```(?:json)?\s*([\s\S]+?)```$/u;

export interface DecodeTaArgs {
  readonly raw: string;
  readonly code: string;
  readonly asof: string;
  readonly barsCount: number;
  readonly fetchedAt: string;
  readonly provider: string;
}

export function decodeTaAnalysis(args: DecodeTaArgs): TaAnalysis {
  const payload = parseJsonObject(args.raw);
  const trend = decodeTrend(payload['trend']);
  const supportLevels = decodeLevels(payload['support_levels']);
  const resistanceLevels = decodeLevels(payload['resistance_levels']);
  const patterns = decodeStringList(payload['patterns'], MAX_PATTERNS);
  const caveats = decodeStringList(payload['caveats'], MAX_PATTERNS);
  return TaAnalysisSchema.parse({
    code: args.code,
    asof: args.asof,
    barsCount: Math.max(0, Math.trunc(args.barsCount)),
    supportLevels,
    resistanceLevels,
    trend,
    patterns,
    caveats,
    provider: args.provider,
    cachedAt: ensureOffsetIso(args.fetchedAt),
  });
}

function parseJsonObject(raw: string): Readonly<Record<string, unknown>> {
  const trimmed = raw.trim();
  const fenced = FENCE_RE.exec(trimmed);
  const stripped = fenced !== null ? fenced[1]?.trim() ?? trimmed : trimmed;
  let payload: unknown;
  try {
    payload = JSON.parse(stripped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QuantError('LLM_FAILED', `ta output is not valid JSON: ${msg}`, {
      snippet: raw.slice(0, 200),
    });
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new QuantError('LLM_FAILED', 'ta output is not a JSON object', {});
  }
  return payload as Readonly<Record<string, unknown>>;
}

function decodeLevels(raw: unknown): readonly TaLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: TaLevel[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Readonly<Record<string, unknown>>;
    const price = coerceDecimalString(e['price']);
    if (price === null) continue;
    const strengthRaw = e['strength'];
    if (typeof strengthRaw !== 'string' || !LEVEL_STRENGTHS.has(strengthRaw)) continue;
    const reasonRaw = e['reason'];
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    out.push({ price, strength: strengthRaw as TaLevel['strength'], reason });
    if (out.length >= MAX_LEVELS) break;
  }
  return out;
}

function decodeTrend(raw: unknown): TaTrend {
  if (typeof raw !== 'object' || raw === null) {
    throw new QuantError('LLM_FAILED', "ta output missing 'trend' object", {});
  }
  const t = raw as Readonly<Record<string, unknown>>;
  const directionRaw = t['direction'];
  if (typeof directionRaw !== 'string' || !TREND_DIRECTIONS.has(directionRaw)) {
    throw new QuantError(
      'LLM_FAILED',
      'ta trend.direction must be up/down/sideways',
      { got: String(directionRaw) },
    );
  }
  const horizon = coerceInt(t['horizon_days']);
  if (horizon === null || horizon <= 0) {
    throw new QuantError(
      'LLM_FAILED',
      'ta trend.horizon_days must be a positive integer',
      { got: String(t['horizon_days']) },
    );
  }
  const confidence = coerceUnitFloat(t['confidence']);
  if (confidence === null) {
    throw new QuantError(
      'LLM_FAILED',
      'ta trend.confidence must be a number in [0,1]',
      { got: String(t['confidence']) },
    );
  }
  const rationaleRaw = t['rationale'];
  const rationale = typeof rationaleRaw === 'string' ? rationaleRaw.trim() : '';
  return {
    direction: directionRaw as TaTrend['direction'],
    horizonDays: horizon,
    confidence,
    rationale,
  };
}

function decodeStringList(raw: unknown, limit: number): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function coerceDecimalString(v: unknown): string | null {
  if (typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return String(v);
  }
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/u.test(v)) return v;
  return null;
}

function coerceInt(v: unknown): number | null {
  if (typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v;
    if (Number.isFinite(v) && Math.floor(v) === v) return v;
    return null;
  }
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

function coerceUnitFloat(v: unknown): number | null {
  if (typeof v === 'boolean') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return clamp01(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return clamp01(n);
  }
  return null;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function ensureOffsetIso(s: string): string {
  if (s.length === 0) return new Date().toISOString();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/u.test(s)) return s;
  return `${s}Z`;
}
