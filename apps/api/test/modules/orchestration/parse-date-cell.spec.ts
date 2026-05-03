/**
 * Regression tests for `parseDateCell` — the cache-inspector's date32
 * decoder. The previous implementation always treated `number` as
 * "days since epoch" and multiplied by 86_400_000, which silently
 * converted watermarks the apache-arrow binding had already emitted
 * as `ms since epoch` into year-56000 dates. That made every code
 * sort *before* `latest_trade_day` and re-enqueue every cron tick.
 */

import { parseDateCell } from '../../../src/modules/orchestration/cache-inspector.js';

describe('parseDateCell', () => {
  it('returns null on null / undefined', () => {
    expect(parseDateCell(null)).toBeNull();
    expect(parseDateCell(undefined)).toBeNull();
  });

  it('formats a UTC-midnight Date as ISO YYYY-MM-DD', () => {
    const d = new Date(Date.UTC(2026, 3, 30)); // April 30, 2026
    expect(parseDateCell(d)).toBe('2026-04-30');
  });

  it('passes ISO string through (truncated to 10)', () => {
    expect(parseDateCell('2026-04-30T00:00:00Z')).toBe('2026-04-30');
    expect(parseDateCell('2026-04-30')).toBe('2026-04-30');
  });

  it('decodes "days since epoch" numbers', () => {
    // 2026-04-30 is 20573 days after 1970-01-01.
    expect(parseDateCell(20573)).toBe('2026-04-30');
  });

  it('decodes "ms since epoch" numbers (regression: re-sync storm)', () => {
    // The bug — apache-arrow emits ms here, the old code multiplied
    // it by 86.4M again and produced year-56000 dates.
    const ms = Date.UTC(2026, 3, 30); // 1777-something-million
    expect(ms).toBeGreaterThan(1e8);
    expect(parseDateCell(ms)).toBe('2026-04-30');
  });

  it('decodes bigint variants the same way numbers are decoded', () => {
    const ms = BigInt(Date.UTC(2026, 3, 30));
    expect(parseDateCell(ms)).toBe('2026-04-30');
  });

  it('returns null for shapes it cannot interpret', () => {
    expect(parseDateCell({})).toBeNull();
    expect(parseDateCell([])).toBeNull();
    expect(parseDateCell(true)).toBeNull();
  });
});
