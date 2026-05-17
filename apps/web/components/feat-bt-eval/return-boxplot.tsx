'use client';

/**
 * Per-holding return-distribution boxplot.
 *
 * Renders one box per holding (5d / 10d / 20d / 60d / 90d):
 *   - thin vertical line   p05 .. p95   (whiskers)
 *   - filled rectangle     p25 .. p75   (IQR box)
 *   - bold horizontal line p50          (median)
 *   - dot                  mean
 * Layout math lives in `lib/fp/boxplot-geometry.ts` — this file is pure
 * SVG mapping so it stays testable via the geometry helper.
 */

import { Box } from '@chakra-ui/react';

import {
  computeBoxLayout,
  type BoxColumn,
  type BoxLayout,
  type BoxStat,
  type YTick,
} from '../../lib/fp/boxplot-geometry.js';

interface ReturnBoxplotProps {
  readonly stats: readonly BoxStat[];
  readonly width: number;
  readonly height: number;
}

const PADDING = [44, 16, 14, 28] as const;

export function ReturnBoxplot({ stats, width, height }: ReturnBoxplotProps): React.ReactElement {
  const layout = computeBoxLayout(stats, { width, height, padding: PADDING, tickHint: 6 });
  return (
    <Box flexShrink={0}>
      <svg width={width} height={height} role="img" aria-label="Return distribution by holding">
        {layout.yTicks.map((tick) => (
          <Tick key={`tick-${String(tick.value)}`} tick={tick} layout={layout} />
        ))}
        {layout.columns.map((col) => (
          <Column key={col.label} col={col} bottomY={layout.plotBottom} />
        ))}
      </svg>
    </Box>
  );
}

function Tick({ tick, layout }: { tick: YTick; layout: BoxLayout }): React.ReactElement {
  const isZero = tick.value === 0;
  return (
    <g>
      <line
        x1={layout.plotLeft}
        x2={layout.plotRight}
        y1={tick.y}
        y2={tick.y}
        stroke={isZero ? '#888' : '#2a2a2a'}
        strokeWidth={isZero ? 1 : 0.5}
        strokeDasharray={isZero ? undefined : '2 3'}
      />
      <text
        x={layout.plotLeft - 6}
        y={tick.y}
        fontFamily="monospace"
        fontSize="10"
        fill="#888"
        textAnchor="end"
        dominantBaseline="middle"
      >
        {formatPct(tick.value)}
      </text>
    </g>
  );
}

function Column({ col, bottomY }: { col: BoxColumn; bottomY: number }): React.ReactElement {
  return (
    <g>
      {col.n > 0 && <BoxShape col={col} />}
      <text
        x={col.cx}
        y={bottomY + 14}
        fontFamily="monospace"
        fontSize="10"
        fill="#bbb"
        textAnchor="middle"
      >
        {col.label}
      </text>
      <text
        x={col.cx}
        y={bottomY + 25}
        fontFamily="monospace"
        fontSize="9"
        fill="#666"
        textAnchor="middle"
      >
        n={String(col.n)}
      </text>
    </g>
  );
}

function BoxShape({ col }: { col: BoxColumn }): React.ReactElement {
  const wHalf = col.halfWidth * 0.5;
  return (
    <>
      <line x1={col.cx} x2={col.cx} y1={col.yP05} y2={col.yP95} stroke="#aaa" strokeWidth={1} />
      <line
        x1={col.cx - wHalf}
        x2={col.cx + wHalf}
        y1={col.yP05}
        y2={col.yP05}
        stroke="#aaa"
        strokeWidth={1}
      />
      <line
        x1={col.cx - wHalf}
        x2={col.cx + wHalf}
        y1={col.yP95}
        y2={col.yP95}
        stroke="#aaa"
        strokeWidth={1}
      />
      <rect
        x={col.cx - col.halfWidth}
        y={col.yP75}
        width={col.halfWidth * 2}
        height={Math.max(col.yP25 - col.yP75, 1)}
        fill="#1f6feb"
        fillOpacity={0.55}
        stroke="#1f6feb"
        strokeWidth={1}
      />
      <line
        x1={col.cx - col.halfWidth}
        x2={col.cx + col.halfWidth}
        y1={col.yMedian}
        y2={col.yMedian}
        stroke="#fff"
        strokeWidth={1.5}
      />
      <circle cx={col.cx} cy={col.yMean} r={2.5} fill="#ffb454" />
    </>
  );
}

function formatPct(v: number): string {
  const pct = v * 100;
  if (Math.abs(pct) >= 10) return `${pct.toFixed(0)}%`;
  return `${pct.toFixed(1)}%`;
}
