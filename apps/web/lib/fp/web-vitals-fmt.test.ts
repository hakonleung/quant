import { describe, expect, it } from 'vitest';

import { fmtCls, fmtMs, vitalColor, vitalTitle } from './web-vitals-fmt.js';
import type { VitalSample } from '../hooks/use-web-vitals.js';

const sample = (value: number, rating: VitalSample['rating']): VitalSample => ({ value, rating });

describe('vitalColor', () => {
  it('returns ink3 when no sample', () => {
    expect(vitalColor(null)).toBe('term.ink3');
  });

  it('maps each rating bucket to the matching terminal palette token', () => {
    expect(vitalColor(sample(1000, 'good'))).toBe('term.green');
    expect(vitalColor(sample(3000, 'needs-improvement'))).toBe('term.amber');
    expect(vitalColor(sample(5000, 'poor'))).toBe('term.red');
  });
});

describe('fmtMs', () => {
  it('returns the em-dash placeholder for null', () => {
    expect(fmtMs(null)).toBe('—');
  });

  it('renders sub-second values as rounded integer ms', () => {
    expect(fmtMs(sample(0, 'good'))).toBe('0ms');
    expect(fmtMs(sample(123.4, 'good'))).toBe('123ms');
    expect(fmtMs(sample(999.999, 'good'))).toBe('1000ms');
    // 1000 itself should switch to seconds (boundary)
    expect(fmtMs(sample(1000, 'good'))).toBe('1.00s');
  });

  it('renders >=1s values with two-decimal seconds', () => {
    expect(fmtMs(sample(1234, 'good'))).toBe('1.23s');
    expect(fmtMs(sample(2500, 'needs-improvement'))).toBe('2.50s');
    expect(fmtMs(sample(12_345, 'poor'))).toBe('12.35s');
  });
});

describe('fmtCls', () => {
  it('returns the em-dash placeholder for null', () => {
    expect(fmtCls(null)).toBe('—');
  });

  it('formats values with three decimals', () => {
    expect(fmtCls(sample(0, 'good'))).toBe('0.000');
    expect(fmtCls(sample(0.05, 'good'))).toBe('0.050');
    expect(fmtCls(sample(0.123_4, 'needs-improvement'))).toBe('0.123');
    expect(fmtCls(sample(0.7, 'poor'))).toBe('0.700');
  });
});

describe('vitalTitle', () => {
  it('describes awaiting-sample state for null', () => {
    expect(vitalTitle('LCP', null)).toContain('awaiting sample');
    expect(vitalTitle('INP', null)).toContain('≤200ms');
    expect(vitalTitle('CLS', null)).toContain('≤0.1');
  });

  it('embeds rating and thresholds for present samples', () => {
    expect(vitalTitle('LCP', sample(1800, 'good'))).toBe('LCP good — good ≤2.5s · poor >4s');
    expect(vitalTitle('INP', sample(450, 'needs-improvement'))).toContain('needs-improvement');
    expect(vitalTitle('CLS', sample(0.4, 'poor'))).toContain('poor');
  });
});
