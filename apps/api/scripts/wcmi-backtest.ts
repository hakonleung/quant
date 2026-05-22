/**
 * WCMI v2 backtest / self-evaluation harness.
 *
 * Purpose: pick the 100 codes with the largest trailing-60-day close_qfq
 * gain from `data/kline/*.parquet`, score them with the current
 * `TUNING_CONFIG` (an overlay on `WCMI_CONFIG`), compute rule-based labels per
 * `docs/perf/wcmi-redesign.md` § 自评与调优流程, and report Spearman ρ +
 * Top-K overlaps so subsequent tuning rounds (task #7) have a baseline
 * to beat.
 *
 * Usage:
 *   pnpm --filter @quant/api exec tsx scripts/wcmi-backtest.ts
 *
 * Outputs:
 *   - stdout: pretty summary (config, metrics, top-30, inconsistency lists)
 *   - docs/perf/data/wcmi-backtest-<YYYY-MM-DD>.json
 *   - docs/perf/wcmi-redesign-backtest.md changelog append (file created if absent)
 *
 * Hard constraints (CLAUDE.md §2.1): no NestJS, no DI, no HTTP. Reads
 * parquet directly via `@duckdb/node-api`. Idempotent — re-running on
 * the same date overwrites the JSON.
 */

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';

import type { BarLike } from '../src/modules/stock-meta/domain/pure/compute-metrics.js';
import {
  WCMI_CONFIG,
  extractWcmiSubscores,
  extractWcmiSubscoreDetail,
  scoreUniverse,
  type ScoringInput,
  type WcmiScore,
  type WcmiSubscoreDetail,
  type WcmiSubscores,
} from '../src/modules/stock-meta/domain/pure/wcmi-scoring.js';

// Tuning playground (task #7). Override individual fields here while
// iterating; spread the default for everything else. Once converged,
// copy back to `WCMI_CONFIG` in `wcmi-subscores/types.ts` and reset
// this to a plain spread.
const TUNING_CONFIG = { ...WCMI_CONFIG } as const;

const SAMPLE_SIZE = 100;
const GAIN_WINDOW_BARS = 60;
const HISTORY_WINDOW = 90;
const MIN_HISTORY = 30;
const TOP_K_LARGE = 30;
const TOP_K_SMALL = 10;
const FALSE_NEG_LABEL_TOP = 15;
const FALSE_NEG_WCMI_FLOOR = 50;
const FALSE_POS_LABEL_FLOOR = 70;
const FALSE_POS_WCMI_TOP = 15;
const PER_DIM_SCATTER_TOP = 10;

interface SampleCode {
  readonly code: string;
  readonly gain60dPct: number;
}

interface CodeBars {
  readonly code: string;
  readonly bars: readonly BarLike[];
}

interface CodeResult {
  readonly code: string;
  readonly gain60dPct: number;
  readonly raw: WcmiSubscores;
  readonly detail: WcmiSubscoreDetail;
  readonly score: WcmiScore;
  readonly labels: LabelBundle;
}

interface LabelBundle {
  readonly rhythm: number;
  readonly aesthetic: number;
  readonly stageGain: number;
  readonly crashAvoid: number;
  readonly composite: number;
}

interface Metrics {
  readonly spearman: number;
  readonly overlap30: number;
  readonly overlap10: number;
  readonly falseNegatives: readonly InconsistencyRow[];
  readonly falsePositives: readonly InconsistencyRow[];
  readonly perDimensionScatter: Readonly<Record<string, readonly ScatterRow[]>>;
}

interface InconsistencyRow {
  readonly code: string;
  readonly labelRank: number;
  readonly wcmiRank: number;
  readonly labelComposite: number;
  readonly wcmiComposite: number;
}

interface ScatterRow {
  readonly code: string;
  readonly labelValue: number;
  readonly pctValue: number;
  readonly diff: number;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');
const KLINE_GLOB = join(REPO_ROOT, 'data/kline/*.parquet');

async function main(): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  console.log(`[wcmi-backtest] reading kline from ${KLINE_GLOB}`);
  const sample = await pickSample(conn);
  console.log(`[wcmi-backtest] picked ${sample.length} sample codes by 60d gain`);
  const barsByCode = await loadWindows(conn, sample.map((s) => s.code));
  console.log(`[wcmi-backtest] loaded windows for ${barsByCode.length} codes`);
  const results = scoreSample(sample, barsByCode);
  console.log(`[wcmi-backtest] scored ${results.length} codes (gate-passing)`);
  const metrics = evaluate(results);
  printSummary(sample, results, metrics);
  const reportPath = await writeJsonReport(sample, results, metrics);
  // Changelog entries are appended manually during tuning rounds; auto-append
  // disabled to keep round labels meaningful. Re-enable for baseline-only runs.
  void appendChangelog;
  console.log(`[wcmi-backtest] JSON report written to ${reportPath}`);
}

async function pickSample(conn: DuckDBConn): Promise<readonly SampleCode[]> {
  const sql = `
    WITH ranked AS (
      SELECT code, ts, close_qfq,
             ROW_NUMBER() OVER (PARTITION BY code ORDER BY ts DESC) AS rn
      FROM read_parquet(${quote(KLINE_GLOB)})
      WHERE close_qfq IS NOT NULL
    ),
    latest AS (SELECT code, close_qfq AS close_now FROM ranked WHERE rn = 1),
    base AS (SELECT code, close_qfq AS close_base FROM ranked WHERE rn = ${GAIN_WINDOW_BARS + 1})
    SELECT l.code,
           (l.close_now / b.close_base - 1) * 100 AS gain_60d_pct
    FROM latest l JOIN base b ON b.code = l.code
    WHERE b.close_base > 0
    ORDER BY gain_60d_pct DESC
    LIMIT ${SAMPLE_SIZE};
  `;
  const result = await conn.runAndReadAll(sql);
  const rows = result.getRowObjects();
  const out: SampleCode[] = [];
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const code = row['code'];
    const gainRaw = row['gain_60d_pct'];
    if (typeof code !== 'string') continue;
    const gain = toFiniteNumber(gainRaw);
    if (gain === null) continue;
    out.push({ code, gain60dPct: gain });
  }
  return out;
}

async function loadWindows(
  conn: DuckDBConn,
  codes: readonly string[],
): Promise<readonly CodeBars[]> {
  if (codes.length === 0) return [];
  const codeListLiteral = codes.map((c) => quote(c)).join(',');
  const sql = `
    WITH ranked AS (
      SELECT code, ts, open_qfq, high_qfq, low_qfq, close_qfq,
             volume, amount, ma5, ma10, ma20, ma60,
             ROW_NUMBER() OVER (PARTITION BY code ORDER BY ts DESC) AS rn
      FROM read_parquet(${quote(KLINE_GLOB)})
      WHERE code IN (${codeListLiteral})
    )
    SELECT code, ts, open_qfq, high_qfq, low_qfq, close_qfq,
           volume, amount, ma5, ma10, ma20, ma60
    FROM ranked
    WHERE rn <= ${HISTORY_WINDOW}
    ORDER BY code, ts ASC;
  `;
  const result = await conn.runAndReadAll(sql);
  const rows = result.getRowObjects();
  const buckets = new Map<string, BarLike[]>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const code = row['code'];
    if (typeof code !== 'string') continue;
    const bar = rowToBar(row);
    if (bar === null) continue;
    const bucket = buckets.get(code);
    if (bucket === undefined) buckets.set(code, [bar]);
    else bucket.push(bar);
  }
  const out: CodeBars[] = [];
  for (const [code, bars] of buckets) {
    if (bars.length >= MIN_HISTORY) out.push({ code, bars });
  }
  return out;
}

function rowToBar(row: Record<string, unknown>): BarLike | null {
  const ts = row['ts'];
  const open = toFiniteNumber(row['open_qfq']);
  const high = toFiniteNumber(row['high_qfq']);
  const low = toFiniteNumber(row['low_qfq']);
  const close = toFiniteNumber(row['close_qfq']);
  if (open === null || high === null || low === null || close === null) return null;
  return {
    trade_date: tsToDate(ts),
    open_qfq: open,
    high_qfq: high,
    low_qfq: low,
    close_qfq: close,
    volume: toFiniteNumber(row['volume']) ?? 0,
    turnover: toFiniteNumber(row['amount']) ?? 0,
    ma5: toFiniteNumber(row['ma5']),
    ma10: toFiniteNumber(row['ma10']),
    ma20: toFiniteNumber(row['ma20']),
    ma60: toFiniteNumber(row['ma60']),
  };
}

function scoreSample(
  sample: readonly SampleCode[],
  windows: readonly CodeBars[],
): readonly CodeResult[] {
  const gainByCode = new Map(sample.map((s) => [s.code, s.gain60dPct]));
  const scoringInputs: ScoringInput[] = [];
  const detailByCode = new Map<string, WcmiSubscoreDetail>();
  const rawByCode = new Map<string, WcmiSubscores>();
  for (const { code, bars } of windows) {
    const raw = extractWcmiSubscores(bars, TUNING_CONFIG);
    const detail = extractWcmiSubscoreDetail(bars, TUNING_CONFIG);
    if (raw === null || detail === null) continue;
    scoringInputs.push({ code, raw });
    rawByCode.set(code, raw);
    detailByCode.set(code, detail);
  }
  const scores = scoreUniverse(scoringInputs, TUNING_CONFIG);
  const out: CodeResult[] = [];
  for (const { code } of scoringInputs) {
    const score = scores.get(code);
    if (score === null || score === undefined) continue;
    const detail = detailByCode.get(code);
    const raw = rawByCode.get(code);
    const gain = gainByCode.get(code);
    if (detail === undefined || raw === undefined || gain === undefined) continue;
    out.push({
      code,
      gain60dPct: gain,
      raw,
      detail,
      score,
      labels: buildLabels(detail),
    });
  }
  return out;
}

function buildLabels(detail: WcmiSubscoreDetail): LabelBundle {
  const rhythm =
    70 * clip01(detail.swingDensity / 2) +
    30 * clip01(detail.lag1Autocorr / 0.3);
  const aesthetic =
    (25 * clip01(detail.maSupportRaw) +
      25 * detail.upWaveSmoothnessRaw * 100 +
      25 * detail.yangDominanceRaw * 100 +
      25 * detail.upperShadowCleanRaw * 100) /
    100;
  const stageGain = clip(detail.stageGainRaw / 1.5, 0, 100);
  const crashAvoid = clip(((detail.crashAvoidanceRaw + 0.5) / 1.5) * 100, 0, 100);
  const composite =
    0.15 * rhythm + 0.45 * aesthetic + 0.2 * stageGain + 0.2 * crashAvoid;
  return { rhythm, aesthetic, stageGain, crashAvoid, composite };
}

function evaluate(results: readonly CodeResult[]): Metrics {
  if (results.length === 0) {
    return {
      spearman: 0,
      overlap30: 0,
      overlap10: 0,
      falseNegatives: [],
      falsePositives: [],
      perDimensionScatter: {},
    };
  }
  const labelComp = results.map((r) => r.labels.composite);
  const wcmiComp = results.map((r) => r.score.composite);
  const labelRank = rankDescending(labelComp);
  const wcmiRank = rankDescending(wcmiComp);
  const spearman = spearmanRho(labelComp, wcmiComp);
  const overlap30 = topKOverlap(labelRank, wcmiRank, TOP_K_LARGE);
  const overlap10 = topKOverlap(labelRank, wcmiRank, TOP_K_SMALL);
  const falseNegatives = collectInconsistencies(
    results,
    labelRank,
    wcmiRank,
    (lr, wr) => lr <= FALSE_NEG_LABEL_TOP && wr > FALSE_NEG_WCMI_FLOOR,
  );
  const falsePositives = collectInconsistencies(
    results,
    labelRank,
    wcmiRank,
    (lr, wr) => lr > FALSE_POS_LABEL_FLOOR && wr <= FALSE_POS_WCMI_TOP,
  );
  const perDimensionScatter = collectPerDimensionScatter(results);
  return {
    spearman,
    overlap30,
    overlap10,
    falseNegatives,
    falsePositives,
    perDimensionScatter,
  };
}

function collectInconsistencies(
  results: readonly CodeResult[],
  labelRank: readonly number[],
  wcmiRank: readonly number[],
  predicate: (labelRank: number, wcmiRank: number) => boolean,
): readonly InconsistencyRow[] {
  const out: InconsistencyRow[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const lr = labelRank[i];
    const wr = wcmiRank[i];
    const r = results[i];
    if (lr === undefined || wr === undefined || r === undefined) continue;
    if (!predicate(lr, wr)) continue;
    out.push({
      code: r.code,
      labelRank: lr,
      wcmiRank: wr,
      labelComposite: r.labels.composite,
      wcmiComposite: r.score.composite,
    });
  }
  out.sort((a, b) => a.labelRank - b.labelRank);
  return out;
}

function collectPerDimensionScatter(
  results: readonly CodeResult[],
): Readonly<Record<string, readonly ScatterRow[]>> {
  const dims: ReadonlyArray<{
    key: string;
    labelValue: (r: CodeResult) => number;
    pctValue: (r: CodeResult) => number;
  }> = [
    { key: 'rhythm', labelValue: (r) => r.labels.rhythm, pctValue: (r) => r.score.pct.rhythm * 100 },
    {
      key: 'aesthetic',
      labelValue: (r) => r.labels.aesthetic,
      pctValue: (r) =>
        ((r.score.pct.maSupport +
          r.score.pct.upWaveSmoothness +
          r.score.pct.yangDominance +
          r.score.pct.upperShadowClean) /
          4) *
        100,
    },
    {
      key: 'stage_gain',
      labelValue: (r) => r.labels.stageGain,
      pctValue: (r) => r.score.pct.stageGain * 100,
    },
    {
      key: 'crash_avoid',
      labelValue: (r) => r.labels.crashAvoid,
      pctValue: (r) => r.score.pct.crashAvoidance * 100,
    },
  ];
  const out: Record<string, readonly ScatterRow[]> = {};
  for (const dim of dims) {
    const rows: ScatterRow[] = results.map((r) => ({
      code: r.code,
      labelValue: dim.labelValue(r),
      pctValue: dim.pctValue(r),
      diff: Math.abs(dim.labelValue(r) - dim.pctValue(r)),
    }));
    rows.sort((a, b) => b.diff - a.diff);
    out[dim.key] = rows.slice(0, PER_DIM_SCATTER_TOP);
  }
  return out;
}

function rankDescending(values: readonly number[]): readonly number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => b.v - a.v);
  const ranks = new Array<number>(values.length).fill(0);
  for (let r = 0; r < indexed.length; r += 1) {
    const entry = indexed[r];
    if (entry === undefined) continue;
    ranks[entry.i] = r + 1;
  }
  return ranks;
}

function spearmanRho(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += rx[i] ?? 0;
    sy += ry[i] ?? 0;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = (rx[i] ?? 0) - mx;
    const b = (ry[i] ?? 0) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

function averageRanks(values: readonly number[]): readonly number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && (indexed[j + 1]?.v ?? 0) === (indexed[i]?.v ?? 0)) j += 1;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) {
      const entry = indexed[k];
      if (entry === undefined) continue;
      out[entry.i] = avgRank;
    }
    i = j + 1;
  }
  return out;
}

function topKOverlap(
  rankA: readonly number[],
  rankB: readonly number[],
  k: number,
): number {
  const aSet = new Set<number>();
  const bSet = new Set<number>();
  for (let i = 0; i < rankA.length; i += 1) {
    const ra = rankA[i];
    const rb = rankB[i];
    if (ra !== undefined && ra <= k) aSet.add(i);
    if (rb !== undefined && rb <= k) bSet.add(i);
  }
  let hit = 0;
  for (const i of aSet) if (bSet.has(i)) hit += 1;
  return hit / k;
}

function printSummary(
  sample: readonly SampleCode[],
  results: readonly CodeResult[],
  metrics: Metrics,
): void {
  console.log('\n=== WCMI Backtest Summary ===');
  console.log(`config: ${JSON.stringify(TUNING_CONFIG)}`);
  console.log(`sample_size=${sample.length} scored=${results.length}`);
  console.log(`spearman_rho=${metrics.spearman.toFixed(4)}`);
  console.log(`overlap_top30=${metrics.overlap30.toFixed(3)}`);
  console.log(`overlap_top10=${metrics.overlap10.toFixed(3)}`);
  const ranked = [...results].sort((a, b) => b.score.composite - a.score.composite);
  console.log('\n-- Top 30 by WCMI --');
  console.log('rank  code     wcmi    label   gain60d  rhythm  aest    stage   crash');
  for (let i = 0; i < Math.min(TOP_K_LARGE, ranked.length); i += 1) {
    const r = ranked[i];
    if (r === undefined) continue;
    console.log(
      `${pad(String(i + 1), 4)}  ${r.code}  ${pad(r.score.composite.toFixed(1), 6)}  ` +
        `${pad(r.labels.composite.toFixed(1), 6)}  ` +
        `${pad(r.gain60dPct.toFixed(1) + '%', 7)}  ` +
        `${pad(r.labels.rhythm.toFixed(1), 6)}  ${pad(r.labels.aesthetic.toFixed(1), 6)}  ` +
        `${pad(r.labels.stageGain.toFixed(1), 6)}  ${pad(r.labels.crashAvoid.toFixed(1), 6)}`,
    );
  }
  console.log(`\nfalse_negatives (label_rank<=15 & wcmi_rank>50): ${metrics.falseNegatives.length}`);
  for (const row of metrics.falseNegatives) {
    console.log(
      `  ${row.code} label_rank=${row.labelRank} wcmi_rank=${row.wcmiRank} ` +
        `label=${row.labelComposite.toFixed(1)} wcmi=${row.wcmiComposite.toFixed(1)}`,
    );
  }
  console.log(`\nfalse_positives (label_rank>70 & wcmi_rank<=15): ${metrics.falsePositives.length}`);
  for (const row of metrics.falsePositives) {
    console.log(
      `  ${row.code} label_rank=${row.labelRank} wcmi_rank=${row.wcmiRank} ` +
        `label=${row.labelComposite.toFixed(1)} wcmi=${row.wcmiComposite.toFixed(1)}`,
    );
  }
}

async function writeJsonReport(
  sample: readonly SampleCode[],
  results: readonly CodeResult[],
  metrics: Metrics,
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const outDir = join(REPO_ROOT, 'docs/perf/data');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `wcmi-backtest-${today}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    config: TUNING_CONFIG,
    sampleSize: sample.length,
    scoredCount: results.length,
    metrics: {
      spearman: metrics.spearman,
      overlapTop30: metrics.overlap30,
      overlapTop10: metrics.overlap10,
      falseNegativeCount: metrics.falseNegatives.length,
      falsePositiveCount: metrics.falsePositives.length,
    },
    falseNegatives: metrics.falseNegatives,
    falsePositives: metrics.falsePositives,
    perDimensionScatter: metrics.perDimensionScatter,
    rows: results.map((r) => ({
      code: r.code,
      gain60dPct: r.gain60dPct,
      wcmiComposite: r.score.composite,
      wcmiPct: r.score.pct,
      labelComposite: r.labels.composite,
      labels: r.labels,
      raw: r.raw,
      detail: r.detail,
    })),
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
  return outPath;
}

async function appendChangelog(metrics: Metrics, reportPath: string): Promise<void> {
  const changelogPath = join(REPO_ROOT, 'docs/perf/wcmi-redesign-backtest.md');
  const today = new Date().toISOString().slice(0, 10);
  let header = '';
  try {
    await access(changelogPath);
  } catch {
    header =
      '# WCMI Backtest Changelog\n\nRolling log of self-evaluation rounds against `data/kline/*.parquet`.\n' +
      'See `docs/perf/wcmi-redesign.md` § 自评与调优流程 for the methodology.\n\n';
    await mkdir(dirname(changelogPath), { recursive: true });
    await writeFile(changelogPath, header, 'utf8');
  }
  const existing = await readFile(changelogPath, 'utf8');
  const entry =
    `## ${today} — baseline (default TUNING_CONFIG)\n` +
    `- spearman_rho: ${metrics.spearman.toFixed(4)}\n` +
    `- overlap_top30: ${metrics.overlap30.toFixed(3)}\n` +
    `- overlap_top10: ${metrics.overlap10.toFixed(3)}\n` +
    `- false_negative_count: ${metrics.falseNegatives.length}\n` +
    `- false_positive_count: ${metrics.falsePositives.length}\n` +
    `- report: \`${reportPath.replace(REPO_ROOT + '/', '')}\`\n\n`;
  await writeFile(changelogPath, existing + entry, 'utf8');
}

function clip(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function clip01(v: number): number {
  return clip(v, 0, 1);
}

function quote(literal: string): string {
  return `'${literal.replace(/'/g, "''")}'`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function tsToDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value.slice(0, 10);
  if (value !== null && typeof value === 'object') {
    const asObj = value as { toString?: () => string };
    if (typeof asObj.toString === 'function') {
      const s = asObj.toString();
      return s.slice(0, 10);
    }
  }
  return '';
}

interface DuckDBConn {
  runAndReadAll(sql: string): Promise<{ getRowObjects(): readonly Record<string, unknown>[] }>;
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[wcmi-backtest] failed: ${msg}`);
  process.exit(1);
});
