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
  const survivors: ScoringInput[] = [];
  for (const item of items) {
    if (item.raw.passesGate) survivors.push(item);
    else out.set(item.code, null);
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
      weights.crashAvoidance * pct.crashAvoidance;
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
  };
  for (const raw of raws) {
    tables.rhythm.push(raw.rhythm);
    tables.maSupport.push(raw.maSupport);
    tables.upWaveSmoothness.push(raw.upWaveSmoothness);
    tables.yangDominance.push(raw.yangDominance);
    tables.upperShadowClean.push(raw.upperShadowClean);
    tables.stageGain.push(raw.stageGain);
    tables.crashAvoidance.push(raw.crashAvoidance);
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
    upperShadowClean: percentileNorm(sortedByKey.upperShadowClean, raw.upperShadowClean),
    stageGain: percentileNorm(sortedByKey.stageGain, raw.stageGain),
    crashAvoidance: percentileNorm(sortedByKey.crashAvoidance, raw.crashAvoidance),
  };
}

interface SubscoreWeights {
  readonly rhythm: number;
  readonly maSupport: number;
  readonly upWaveSmoothness: number;
  readonly yangDominance: number;
  readonly upperShadowClean: number;
  readonly stageGain: number;
  readonly crashAvoidance: number;
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
    w.crashAvoidance
  );
}
