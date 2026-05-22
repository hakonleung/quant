import type { BarLike } from '../../../../../../src/modules/stock-meta/domain/pure/compute-metrics.js';
import { extractWcmiSubscores } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/extract.js';
import { scoreUniverse } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/score-universe.js';
import { WCMI_CONFIG, type ScoringInput } from '../../../../../../src/modules/stock-meta/domain/pure/wcmi-subscores/types.js';

function makeBars(n: number, closeFn: (i: number) => number): BarLike[] {
  return Array.from({ length: n }, (_, i) => {
    const c = closeFn(i);
    return {
      trade_date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open_qfq: c,
      high_qfq: c,
      low_qfq: c,
      close_qfq: c,
      volume: 0,
      turnover: 0,
      ma5: null,
      ma10: null,
      ma20: null,
      ma60: null,
    };
  });
}

function makeScoringInput(code: string, rising: boolean): ScoringInput {
  const bars = makeBars(30, (i) => (rising ? 100 + i : 100 - i));
  const raw = extractWcmiSubscores(bars, WCMI_CONFIG)!;
  return { code, raw };
}

it('scoreUniverse: empty universe returns empty map', () => {
  const result = scoreUniverse([], WCMI_CONFIG);
  expect(result.size).toBe(0);
});

it('scoreUniverse: single surviving stock gets composite in [0, WCMI_TOTAL_SCALE]', () => {
  const input = makeScoringInput('A', true);
  const result = scoreUniverse([input], WCMI_CONFIG);
  const score = result.get('A');
  expect(score).not.toBeNull();
  expect(score!.composite).toBeGreaterThanOrEqual(0);
  expect(score!.composite).toBeLessThanOrEqual(WCMI_CONFIG.WCMI_TOTAL_SCALE);
});

it('scoreUniverse: gate-failed codes receive null', () => {
  const failing = makeScoringInput('fail', false);
  expect(failing.raw.passesGate).toBe(false);
  const result = scoreUniverse([failing], WCMI_CONFIG);
  expect(result.get('fail')).toBeNull();
});

it('scoreUniverse: pct fields are all in [0, 1]', () => {
  const inputs: ScoringInput[] = [
    makeScoringInput('A', true),
    makeScoringInput('B', true),
    makeScoringInput('C', true),
  ];
  const result = scoreUniverse(inputs, WCMI_CONFIG);
  for (const code of ['A', 'B', 'C']) {
    const score = result.get(code)!;
    const pct = score.pct;
    expect(pct.rhythm).toBeGreaterThanOrEqual(0);
    expect(pct.rhythm).toBeLessThanOrEqual(1);
    expect(pct.maSupport).toBeGreaterThanOrEqual(0);
    expect(pct.crashAvoidance).toBeLessThanOrEqual(1);
  }
});

it('scoreUniverse: all-gate-failed universe returns map of nulls', () => {
  const inputs = [makeScoringInput('A', false), makeScoringInput('B', false)];
  const result = scoreUniverse(inputs, WCMI_CONFIG);
  expect(result.get('A')).toBeNull();
  expect(result.get('B')).toBeNull();
});

it('scoreUniverse: weights sum correctly — composite bounded by scale', () => {
  const inputs: ScoringInput[] = Array.from({ length: 5 }, (_, i) =>
    makeScoringInput(`S${i}`, true),
  );
  const result = scoreUniverse(inputs, WCMI_CONFIG);
  for (const [, score] of result) {
    if (score !== null) {
      expect(score.composite).toBeLessThanOrEqual(WCMI_CONFIG.WCMI_TOTAL_SCALE + 1e-9);
      expect(score.composite).toBeGreaterThanOrEqual(-1e-9);
    }
  }
});
