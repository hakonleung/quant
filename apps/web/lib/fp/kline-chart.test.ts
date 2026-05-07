import { describe, expect, it } from 'vitest';
import type { KlineBar } from '@quant/shared';

import { DEFAULT_GEOMETRY, buildLayout, buildMaPath, pctChangeToLatest } from './kline-chart.js';

const bar = (over: Partial<KlineBar> = {}): KlineBar => ({
  date: '2026-01-01',
  open: 100,
  high: 110,
  low: 90,
  close: 105,
  volume: 0,
  turnover: 0,
  turnoverRate: 0,
  ma5: null,
  ma10: null,
  ma20: null,
  ma60: null,
  ...over,
});

describe('buildLayout', () => {
  it('returns an empty layout when no bars', () => {
    const out = buildLayout([]);
    expect(out.layout).toEqual([]);
    expect(out.scaleY(100)).toBeTypeOf('number');
  });

  it('places candles at leftPad + i * stride', () => {
    const bars = [bar(), bar({ open: 105, close: 100 })];
    const { layout } = buildLayout(bars);
    expect(layout[0]!.x).toBe(DEFAULT_GEOMETRY.leftPad);
    expect(layout[1]!.x).toBe(
      DEFAULT_GEOMETRY.leftPad + DEFAULT_GEOMETRY.candleWidth + DEFAULT_GEOMETRY.candleGap,
    );
  });

  it('flags up bar when close >= open', () => {
    const { layout } = buildLayout([bar({ open: 100, close: 110 })]);
    expect(layout[0]!.up).toBe(true);
  });

  it('flags down bar when close < open', () => {
    const { layout } = buildLayout([bar({ open: 110, close: 100 })]);
    expect(layout[0]!.up).toBe(false);
  });

  it('clamps body height to at least 2', () => {
    const { layout } = buildLayout([bar({ open: 100, close: 100 })]);
    expect(layout[0]!.bodyH).toBeGreaterThanOrEqual(2);
  });

  it('scaleY puts the max price near the top and min near the bottom', () => {
    const bars = [bar({ high: 200, low: 100, open: 150, close: 160 })];
    const { scaleY } = buildLayout(bars);
    expect(scaleY(200)).toBeLessThan(scaleY(100));
  });
});

describe('buildMaPath', () => {
  it('returns null when no bar has the requested MA', () => {
    const { scaleY } = buildLayout([bar()]);
    expect(buildMaPath([bar()], 'ma5', scaleY)).toBeNull();
  });

  it('skips bars without an MA value', () => {
    const bars = [bar({ ma5: null }), bar({ ma5: 105 })];
    const { scaleY } = buildLayout(bars);
    const path = buildMaPath(bars, 'ma5', scaleY);
    expect(path).not.toBeNull();
    expect(path!.split('M').length).toBe(2);
  });

  it('produces M then L segments when multiple MAs are present', () => {
    const bars = [bar({ ma5: 100 }), bar({ ma5: 105 }), bar({ ma5: 110 })];
    const { scaleY } = buildLayout(bars);
    const path = buildMaPath(bars, 'ma5', scaleY)!;
    expect(path.startsWith('M')).toBe(true);
    expect(path.split('L').length).toBe(3);
  });

  it('handles the new ma10 key', () => {
    const bars = [bar({ ma10: 102 }), bar({ ma10: 104 })];
    const { scaleY } = buildLayout(bars);
    expect(buildMaPath(bars, 'ma10', scaleY)).not.toBeNull();
  });
});

describe('pctChangeToLatest', () => {
  const series = [bar({ close: 100 }), bar({ close: 110 }), bar({ close: 121 })];

  it('returns null for the latest bar', () => {
    expect(pctChangeToLatest(series, 2)).toBeNull();
  });

  it('returns null on out-of-range index', () => {
    expect(pctChangeToLatest(series, 99)).toBeNull();
    expect(pctChangeToLatest([], 0)).toBeNull();
  });

  it('computes pct from selected close to latest close', () => {
    // (121 - 100) / 100 * 100 = 21
    expect(pctChangeToLatest(series, 0)).toBe(21);
    // (121 - 110) / 110 * 100 = 10
    expect(pctChangeToLatest(series, 1)).toBeCloseTo(10);
  });

  it('returns null when the selected close is zero', () => {
    expect(pctChangeToLatest([bar({ close: 0 }), bar({ close: 5 })], 0)).toBeNull();
  });
});
