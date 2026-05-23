import type {
  WcmiConfig,
  WcmiPctBreakdown,
  WcmiScore,
  ScoringInput,
  WcmiSubscores,
} from './types.js';
import { percentileNorm } from './utils.js';

type SubscoreKey = Exclude<keyof WcmiPctBreakdown, never>;

const SUBSCORE_KEYS: readonly SubscoreKey[] = [
  'rhythm',
  'maSupport',
  'upWaveSmoothness',
  'yangDominance',
  'upperShadowClean',
  'stageGain',
  'crashAvoidance',
  'recentStrength',
];

/**
 * Build cross-sectional percentile tables across all survivors then
 * composite each survivor's score using the configured weights.
 *
 * Gate-failed (or missing) codes receive `null`. Empty input yields an
 * empty map.
 */
export function scoreUniverse(
  items: readonly ScoringInput[],
  config: WcmiConfig,
): Map<string, WcmiScore | null> {
  const out = new Map<string, WcmiScore | null>();
  if (items.length === 0) return out;
  const blacklist = new Set(config.PERMANENT_BLACKLIST);
  const survivors: ScoringInput[] = [];
  for (const item of items) {
    if (blacklist.has(item.code) || !item.raw.passesGate) out.set(item.code, null);
    else survivors.push(item);
  }
  if (survivors.length === 0) return out;
  const sortedByKey = buildSortedTables(survivors.map((s) => s.raw));
  const weights = weightsFor(config);
  const weightSum = sumWeights(weights);
  const scale = weightSum > 0 ? config.WCMI_TOTAL_SCALE / weightSum : 0;
  for (const survivor of survivors) {
    const pct = computePct(survivor.raw, sortedByKey);
    const weighted =
      weights.rhythm * pct.rhythm +
      weights.maSupport * pct.maSupport +
      weights.upWaveSmoothness * pct.upWaveSmoothness +
      weights.yangDominance * pct.yangDominance +
      weights.upperShadowClean * pct.upperShadowClean +
      weights.stageGain * pct.stageGain +
      weights.crashAvoidance * pct.crashAvoidance +
      weights.recentStrength * pct.recentStrength;
    out.set(survivor.code, { composite: scale * weighted, pct });
  }
  return out;
}

type SortedTables = Readonly<Record<SubscoreKey, readonly number[]>>;

function buildSortedTables(raws: readonly WcmiSubscores[]): SortedTables {
  const tables: Record<SubscoreKey, number[]> = {
    rhythm: [],
    maSupport: [],
    upWaveSmoothness: [],
    yangDominance: [],
    upperShadowClean: [],
    stageGain: [],
    crashAvoidance: [],
    recentStrength: [],
  };
  for (const raw of raws) {
    tables.rhythm.push(raw.rhythm);
    tables.maSupport.push(raw.maSupport);
    tables.upWaveSmoothness.push(raw.upWaveSmoothness);
    tables.yangDominance.push(raw.yangDominance);
    tables.upperShadowClean.push(raw.upperShadowClean);
    tables.stageGain.push(raw.stageGain);
    tables.crashAvoidance.push(raw.crashAvoidance);
    tables.recentStrength.push(raw.recentStrength);
  }
  for (const key of SUBSCORE_KEYS) tables[key].sort((a, b) => a - b);
  return tables;
}

function computePct(raw: WcmiSubscores, sortedByKey: SortedTables): WcmiPctBreakdown {
  return {
    rhythm: percentileNorm(sortedByKey.rhythm, raw.rhythm),
    maSupport: percentileNorm(sortedByKey.maSupport, raw.maSupport),
    upWaveSmoothness: percentileNorm(sortedByKey.upWaveSmoothness, raw.upWaveSmoothness),
    yangDominance: percentileNorm(sortedByKey.yangDominance, raw.yangDominance),
    upperShadowClean: compressRange(
      percentileNorm(sortedByKey.upperShadowClean, raw.upperShadowClean),
      0.4,
    ),
    stageGain: percentileNorm(sortedByKey.stageGain, raw.stageGain),
    crashAvoidance: compressRange(
      percentileNorm(sortedByKey.crashAvoidance, raw.crashAvoidance),
      0.4,
    ),
    recentStrength: percentileNorm(sortedByKey.recentStrength, raw.recentStrength),
  };
}

/**
 * Linearly map `pct ∈ [0, 1]` into `[floor, 1]` so this dimension can
 * only ever drag the composite down by `(1 - floor)` of its weight.
 * Used for upper_shadow_clean and crash_avoidance — both are heavy-tail
 * "penalty" signals where the bottom of the cross-section is mostly
 * noise we don't want to fully zero out.
 */
function compressRange(pct: number, floor: number): number {
  return floor + (1 - floor) * pct;
}

interface SubscoreWeights {
  readonly rhythm: number;
  readonly maSupport: number;
  readonly upWaveSmoothness: number;
  readonly yangDominance: number;
  readonly upperShadowClean: number;
  readonly stageGain: number;
  readonly crashAvoidance: number;
  readonly recentStrength: number;
}

function weightsFor(config: WcmiConfig): SubscoreWeights {
  return {
    rhythm: config.W_RHYTHM,
    maSupport: config.W_MA_SUPPORT,
    upWaveSmoothness: config.W_UP_WAVE,
    yangDominance: config.W_YANG_DOM,
    upperShadowClean: config.W_SHADOW_CLEAN,
    stageGain: config.W_STAGE_GAIN,
    crashAvoidance: config.W_CRASH_AVOID,
    recentStrength: config.W_RECENT_STRENGTH,
  };
}

function sumWeights(w: SubscoreWeights): number {
  return (
    w.rhythm +
    w.maSupport +
    w.upWaveSmoothness +
    w.yangDominance +
    w.upperShadowClean +
    w.stageGain +
    w.crashAvoidance +
    w.recentStrength
  );
}
