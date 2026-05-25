'use client';

/**
 * Presentational sub-pieces for ReturnDistributionChart: axis, bars,
 * reference lines, crosshair, empty hint, hover tooltip. Kept here so
 * the main chart file stays under the 400-line cap (CLAUDE.md §1.2)
 * and the layout primitives can be unit-shot in isolation.
 *
 * Theme-aware colour values arrive via `DistColors` props from the
 * parent stack — the stack pulls all `dist.*` semantic tokens in one
 * `useTokenColors` call.
 */

import { Box } from '@chakra-ui/react';

import type { HistogramBin } from '../../lib/fp/return-histogram.js';

export const PAD = { top: 10, right: 12, bottom: 22, left: 36 } as const;

/**
 * Resolved palette for the distribution chart. Field names mirror the
 * `dist.*` semantic-token paths in `lib/theme/system.ts`. Bundling them
 * into a single props object keeps each sub-piece's signature stable
 * across theme flips.
 */
export interface DistColors {
  readonly zero: string;
  readonly mean: string;
  readonly median: string;
  readonly baseline: string;
  readonly kdeLine: string;
  readonly barFill: string;
  readonly barStroke: string;
  readonly axisLine: string;
  readonly axisTick: string;
  readonly axisLabel: string;
  readonly crosshair: string;
  readonly emptyText: string;
}

export interface HoverState {
  readonly bin: HistogramBin;
  readonly cx: number;
  readonly mouseX: number;
  readonly mouseY: number;
}

export function formatPct(v: number): string {
  const pct = v * 100;
  if (Number.isInteger(pct)) return `${pct.toFixed(0)}%`;
  if (Math.abs(pct) >= 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(1)}%`;
}

export interface BarsProps {
  readonly bins: readonly HistogramBin[];
  readonly maxCount: number;
  readonly innerH: number;
  readonly xFor: (v: number) => number;
  readonly hover: HoverState | null;
  readonly colors: DistColors;
}

export function Bars({
  bins,
  maxCount,
  innerH,
  xFor,
  hover,
  colors,
}: BarsProps): React.ReactElement {
  const safeMax = Math.max(maxCount, 1);
  return (
    <g>
      {bins.map((b, i) => {
        const x0 = xFor(b.x0);
        const x1 = xFor(b.x1);
        const w = Math.max(x1 - x0 - 1, 1);
        const h = (b.count / safeMax) * innerH;
        const y = PAD.top + innerH - h;
        const isHover = hover !== null && hover.bin === b;
        return (
          <rect
            key={`bin-${String(i)}`}
            x={x0 + 0.5}
            y={y}
            width={w}
            height={Math.max(h, 0)}
            fill={colors.barFill}
            fillOpacity={0.35}
            stroke={colors.barStroke}
            strokeWidth={isHover ? 1.5 : 0.5}
            opacity={hover === null ? 1 : isHover ? 1 : 0.6}
          />
        );
      })}
    </g>
  );
}

export interface XAxisProps {
  readonly domainMin: number;
  readonly domainMax: number;
  readonly width: number;
  readonly height: number;
  readonly xFor: (v: number) => number;
  readonly colors: DistColors;
}

export function XAxis({
  domainMin,
  domainMax,
  width,
  height,
  xFor,
  colors,
}: XAxisProps): React.ReactElement {
  const ticks = niceAxisTicks(domainMin, domainMax, width - PAD.left - PAD.right);
  const y = height - PAD.bottom;
  return (
    <g>
      <line
        x1={PAD.left}
        x2={width - PAD.right}
        y1={y}
        y2={y}
        stroke={colors.axisLine}
        strokeWidth={0.5}
      />
      {ticks.map((t) => (
        <g key={`xt-${String(t)}`}>
          <line
            x1={xFor(t)}
            x2={xFor(t)}
            y1={y}
            y2={y + 2}
            stroke={colors.axisTick}
            strokeWidth={0.5}
          />
          <text
            x={xFor(t)}
            y={y + 9}
            fill={colors.axisLabel}
            textAnchor="middle"
            style={{ fontSize: '8px' }}
          >
            {formatPctNumber(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

function formatPctNumber(v: number): string {
  const pct = v * 100;
  if (Number.isInteger(pct)) return pct.toFixed(0);
  return pct.toFixed(1);
}

export interface RefLinesProps {
  readonly xFor: (v: number) => number;
  readonly height: number;
  readonly mean: number;
  readonly median: number;
  readonly baseline: number | null;
  readonly colors: DistColors;
}

export function RefLines({
  xFor,
  height,
  mean,
  median,
  baseline,
  colors,
}: RefLinesProps): React.ReactElement {
  const y2 = height - PAD.bottom;
  return (
    <g>
      <RefLine x={xFor(0)} y1={PAD.top} y2={y2} color={colors.zero} dashed />
      <RefLine x={xFor(mean)} y1={PAD.top} y2={y2} color={colors.mean} />
      <RefLine x={xFor(median)} y1={PAD.top} y2={y2} color={colors.median} dashed />
      {baseline !== null && (
        <RefLine x={xFor(baseline)} y1={PAD.top} y2={y2} color={colors.baseline} dashed />
      )}
    </g>
  );
}

interface RefLineProps {
  readonly x: number;
  readonly y1: number;
  readonly y2: number;
  readonly color: string;
  readonly dashed?: boolean;
}

function RefLine({ x, y1, y2, color, dashed }: RefLineProps): React.ReactElement {
  return (
    <line
      x1={x}
      x2={x}
      y1={y1}
      y2={y2}
      stroke={color}
      strokeWidth={1.5}
      strokeDasharray={dashed === true ? '4 3' : undefined}
      opacity={0.95}
    />
  );
}

export function Crosshair({
  cx,
  height,
  color,
}: {
  readonly cx: number;
  readonly height: number;
  readonly color: string;
}): React.ReactElement {
  return (
    <line
      x1={cx}
      x2={cx}
      y1={PAD.top}
      y2={height - PAD.bottom}
      stroke={color}
      strokeWidth={0.5}
      strokeDasharray="2 2"
      opacity={0.6}
    />
  );
}

export function EmptyHint({
  width,
  height,
  color,
}: {
  readonly width: number;
  readonly height: number;
  readonly color: string;
}): React.ReactElement {
  return (
    <text
      x={width / 2}
      y={height / 2}
      fontFamily="monospace"
      fontSize="10"
      fill={color}
      textAnchor="middle"
      dominantBaseline="middle"
    >
      样本不足
    </text>
  );
}

export interface TooltipProps {
  readonly bin: HistogramBin;
  readonly totalCount: number;
  readonly mouseX: number;
  readonly mouseY: number;
  readonly width: number;
}

export function Tooltip({
  bin,
  totalCount,
  mouseX,
  mouseY,
  width,
}: TooltipProps): React.ReactElement {
  const pct = totalCount === 0 ? 0 : (bin.count / totalCount) * 100;
  const text = `区间 [${formatPct(bin.x0)}, ${formatPct(bin.x1)}) · 频数 ${String(bin.count)} · 占比 ${pct.toFixed(1)}%`;
  const left = Math.min(Math.max(mouseX + 10, 4), width - 220);
  const top = Math.max(mouseY - 28, 0);
  return (
    <Box
      position="absolute"
      left={`${String(left)}px`}
      top={`${String(top)}px`}
      px="6px"
      py="2px"
      fontSize="10px"
      fontFamily="mono"
      color="ink"
      bg="panel"
      border="1px solid"
      borderColor="line"
      whiteSpace="nowrap"
      pointerEvents="none"
      lineHeight="1.3"
    >
      {text}
    </Box>
  );
}

const NICE_STEPS_PCT = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50] as const;
const PX_PER_TICK = 20;

function niceAxisTicks(min: number, max: number, pxWidth: number): number[] {
  if (!(max > min) || pxWidth <= 0) return [min];
  const desired = Math.max(2, Math.floor(pxWidth / PX_PER_TICK));
  const rawStepPct = ((max - min) * 100) / desired;
  let stepPct = NICE_STEPS_PCT[NICE_STEPS_PCT.length - 1] ?? 50;
  for (const s of NICE_STEPS_PCT) {
    if (s >= rawStepPct) {
      stepPct = s;
      break;
    }
  }
  const step = stepPct / 100;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step / 2; v += step) {
    out.push(Math.round(v / step) * step);
  }
  return out;
}
