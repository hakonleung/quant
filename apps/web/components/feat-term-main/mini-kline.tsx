'use client';

/**
 * Pure ASCII line chart for the TERM.MAIN dashboard. Mirrors the look
 * of the CRT-terminal reference (docs/CRT Terminal - standalone.html):
 *
 *   ◆ <code> 90D
 *   290 │      ┌──┐
 *   285 │   ┌──┘  │
 *   280 │───┘     └──
 *   275 │
 *   270 │
 *       └────────────
 *          M T W T F
 *
 * Implementation notes:
 *   - draw the close-price stepped line with box-drawing chars
 *     (`─`, `│`, `┌`, `┐`, `└`, `┘`)
 *   - emit ~5 evenly-spaced Y-axis price labels along the left
 *   - X-axis labels are 5 month/week buckets sampled from `bars[].date`
 *   - volume row is a small monochrome sparkline strip below the axis
 *
 * Pure presentation; no IO. Fed via a `KlineBar[]` prop.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { KlineBar } from '@quant/shared';

interface Props {
  readonly bars: readonly KlineBar[];
  /** Visible chart columns (price area only — Y-axis adds 5 cols). */
  readonly cols?: number;
  /** Plot rows (price area only — X-axis adds 2 rows). */
  readonly rows?: number;
}

const VOL_SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
const Y_TICKS = 5;
const X_TICKS = 5;

export function MiniKline({ bars, cols = 36, rows = 6 }: Props): React.ReactElement {
  if (bars.length === 0) {
    return (
      <Text color="term.ink3" fontSize="xs">
        no kline cached — run `update`
      </Text>
    );
  }
  const window = bars.slice(-cols);
  const closes = window.map((b) => b.close);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);

  const grid = drawStepChart(closes, rows, window.length);
  const yLabels = buildYLabels(lo, hi, rows);
  const xLabels = buildXLabels(
    window.map((b) => b.date),
    X_TICKS,
    window.length,
  );

  return (
    <Box fontFamily="geek" fontSize="xs" color="term.green" lineHeight="1.05">
      {grid.map((row, r) => (
        <Box key={r} display="flex">
          <Box
            as="span"
            color="term.ink3"
            display="inline-block"
            w="34px"
            textAlign="right"
            pr="6px"
          >
            {yLabels[r] ?? ''}
          </Box>
          <Box as="span" color="term.ink3">
            │
          </Box>
          <Box as="span" color="term.green" whiteSpace="pre">
            {row.join('')}
          </Box>
        </Box>
      ))}
      {/* X-axis line */}
      <Flex>
        <Box as="span" w="34px" />
        <Box as="span" color="term.ink3">
          └
        </Box>
        <Box as="span" color="term.ink3">
          {'─'.repeat(window.length)}
        </Box>
      </Flex>
      {/* X-axis labels */}
      <Flex>
        <Box as="span" w="34px" />
        <Box as="span" w="6px" />
        <Box as="span" color="term.ink3" whiteSpace="pre">
          {renderXAxisLabels(xLabels, window.length)}
        </Box>
      </Flex>

      {/* Volume strip */}
      <Flex mt="6px">
        <Box as="span" color="term.ink3" w="34px" textAlign="right" pr="6px" fontSize="xs">
          vol
        </Box>
        <Box as="span" color="term.ink3">
          │
        </Box>
        <Box as="span" color="up" opacity={0.85} whiteSpace="pre">
          {scaleToSpark(window.map((b) => b.volume))}
        </Box>
      </Flex>
    </Box>
  );
}

/* ---------- step-line plotter ---------- */

function drawStepChart(values: readonly number[], rows: number, cols: number): string[][] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const heights = values.slice(0, cols).map((v) => Math.round((1 - (v - lo) / span) * (rows - 1)));

  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '));

  for (let c = 0; c < heights.length; c++) {
    const h = heights[c]!;
    if (c === 0) {
      grid[h]![c] = '─';
      continue;
    }
    const ph = heights[c - 1]!;
    if (ph === h) {
      grid[h]![c] = '─';
    } else if (h > ph) {
      // line drops
      grid[ph]![c] = '┐';
      for (let r = ph + 1; r < h; r++) grid[r]![c] = '│';
      grid[h]![c] = '└';
    } else {
      // line rises
      grid[ph]![c] = '┘';
      for (let r = h + 1; r < ph; r++) grid[r]![c] = '│';
      grid[h]![c] = '┌';
    }
  }
  return grid;
}

/* ---------- axis labels ---------- */

function buildYLabels(lo: number, hi: number, rows: number): string[] {
  // Show approximately Y_TICKS labels distributed across the rows. We
  // map row-index → fractional position → price, then format compactly.
  const labels: string[] = Array(rows).fill('');
  const tickRows = pickEvenRows(rows, Math.min(Y_TICKS, rows));
  for (const r of tickRows) {
    const t = 1 - r / Math.max(1, rows - 1);
    const v = lo + t * (hi - lo);
    labels[r] = fmtPrice(v);
  }
  return labels;
}

function pickEvenRows(rows: number, count: number): number[] {
  if (count <= 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round((i / (count - 1)) * (rows - 1)));
  }
  return [...new Set(out)];
}

function fmtPrice(v: number): string {
  if (v >= 1000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function buildXLabels(
  dates: readonly string[],
  ticks: number,
  cols: number,
): { col: number; label: string }[] {
  if (dates.length === 0 || cols === 0) return [];
  const out: { col: number; label: string }[] = [];
  for (let i = 0; i < ticks; i++) {
    const idx = Math.round((i / (ticks - 1)) * (dates.length - 1));
    const col = Math.round((i / (ticks - 1)) * (cols - 1));
    const date = dates[idx];
    if (date === undefined) continue;
    // dates are 'YYYY-MM-DD' — show MM-DD for compactness.
    out.push({ col, label: date.slice(5) });
  }
  return out;
}

function renderXAxisLabels(
  labels: readonly { col: number; label: string }[],
  cols: number,
): string {
  // Build a row of `cols + 1` characters where each label starts at the
  // tick column. Labels can overlap on narrow viewports — last writer
  // wins, which is acceptable since ticks are evenly spaced.
  const buf = Array(cols + 8).fill(' ');
  for (const { col, label } of labels) {
    const start = Math.max(0, col - Math.floor(label.length / 2));
    for (let i = 0; i < label.length; i++) buf[start + i] = label[i] ?? ' ';
  }
  return buf.join('').slice(0, cols + 1);
}

/* ---------- volume strip ---------- */

function scaleToSpark(values: readonly number[]): string {
  if (values.length === 0) return '';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  if (span === 0) return VOL_SPARK[3]!.repeat(values.length);
  return values
    .map((v) => {
      const t = (v - lo) / span;
      const idx = Math.min(VOL_SPARK.length - 1, Math.max(0, Math.floor(t * VOL_SPARK.length)));
      return VOL_SPARK[idx]!;
    })
    .join('');
}
