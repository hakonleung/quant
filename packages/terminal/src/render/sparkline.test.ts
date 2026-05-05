import { describe, expect, it } from 'vitest';
import { sparkline } from '../render/sparkline.js';

describe('sparkline', () => {
  it('returns empty string for empty input (boundary)', () => {
    expect(sparkline([])).toBe('');
  });

  it('produces one cell per value (golden)', () => {
    expect(sparkline([1, 2, 3, 4]).length).toBe(4);
  });

  it('flat data renders all middle ticks', () => {
    expect(sparkline([5, 5, 5, 5])).toBe('▄▄▄▄');
  });

  it('renders min as low tick and max as high tick', () => {
    const s = sparkline([0, 10]);
    expect(s[0]).toBe('▁');
    expect(s[1]).toBe('█');
  });

  it('treats NaN as space', () => {
    const s = sparkline([1, Number.NaN, 2]);
    expect(s[1]).toBe(' ');
  });
});
