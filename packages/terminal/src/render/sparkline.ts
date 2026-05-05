/**
 * Unicode sparkline for kline rendering.
 * Pure module (CLAUDE.md §2.5.1).
 */

const TICKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * Map `values` to a sparkline of length `values.length` (one cell per value).
 * Returns empty string for empty input. NaN / non-finite values are ignored
 * for min/max purposes and rendered as a space.
 */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return '';
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return ' '.repeat(values.length);
  let min = finite[0] as number;
  let max = min;
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) return TICKS[3]!.repeat(values.length);
  return values
    .map((v) => {
      if (!Number.isFinite(v)) return ' ';
      const ratio = (v - min) / range;
      const idx = Math.min(TICKS.length - 1, Math.max(0, Math.round(ratio * (TICKS.length - 1))));
      return TICKS[idx] ?? ' ';
    })
    .join('');
}
