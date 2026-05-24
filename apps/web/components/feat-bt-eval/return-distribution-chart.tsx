'use client';

/**
 * Single-holding return-distribution chart: histogram bars + Gaussian
 * KDE overlay, shared x-domain provided by the parent stack. Hover
 * shows a crosshair + tooltip with the bin under the cursor.
 *
 * Layout / smoothing math lives in `lib/fp/return-histogram.ts` and
 * `lib/fp/gaussian-kde.ts`. Presentational sub-pieces (axis, bars,
 * tooltip, …) live in `./return-distribution-pieces.tsx` so this file
 * stays under the 400-line cap.
 */

import { Box } from '@chakra-ui/react';
import { useMemo, useState } from 'react';

import { kde, linspace, silvermanBandwidth } from '../../lib/fp/gaussian-kde.js';
import {
  buildHistogram,
  pickBinCount,
  type HistogramBin,
} from '../../lib/fp/return-histogram.js';
import {
  Bars,
  Crosshair,
  EmptyHint,
  KDE_COLOR,
  PAD,
  RefLines,
  Tooltip,
  XAxis,
  type HoverState,
} from './return-distribution-pieces.js';

export interface ReturnDistributionChartProps {
  readonly holding: number;
  readonly returns: readonly number[];
  readonly domainMin: number;
  readonly domainMax: number;
  readonly mean: number;
  readonly median: number;
  readonly baseline: number | null;
  readonly summaryLine: string;
  readonly width: number;
  readonly height: number;
}

const KDE_SAMPLES = 80;
const KDE_STROKE = KDE_COLOR;

export function ReturnDistributionChart(
  props: ReturnDistributionChartProps,
): React.ReactElement {
  const { width, height, returns, domainMin, domainMax, holding } = props;
  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = Math.max(1, height - PAD.top - PAD.bottom);
  const histogram = useMemo(
    () => buildHistogram(returns, pickBinCount(returns), domainMin, domainMax),
    [returns, domainMin, domainMax],
  );
  const kdePath = useMemo(
    () => buildKdePath(returns, domainMin, domainMax, innerW, innerH, histogram.maxCount),
    [returns, domainMin, domainMax, innerW, innerH, histogram.maxCount],
  );
  const [hover, setHover] = useState<HoverState | null>(null);
  const xFor = (v: number): number =>
    PAD.left + ((v - domainMin) / Math.max(domainMax - domainMin, 1e-12)) * innerW;
  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    setHover(computeHover(e, histogram.bins, innerW, xFor));
  };
  const onLeave = (): void => {
    setHover(null);
  };
  return (
    <Box position="relative" width={`${String(width)}px`} flexShrink={0}>
      <HeaderLabel text={props.summaryLine} />
      <ChartSvg
        {...{ width, height, innerH, domainMin, domainMax, xFor, histogram, kdePath, hover }}
        ariaLabel={`持仓 ${String(holding)} 日收益分布`}
        onMove={onMove}
        onLeave={onLeave}
        mean={props.mean}
        median={props.median}
        baseline={props.baseline}
      />
      {hover !== null && (
        <Tooltip
          bin={hover.bin}
          totalCount={returns.length}
          mouseX={hover.mouseX}
          mouseY={hover.mouseY}
          width={width}
        />
      )}
    </Box>
  );
}

function HeaderLabel({ text }: { readonly text: string }): React.ReactElement {
  return (
    <Box
      fontFamily="mono"
      fontSize="10px"
      color="ink3"
      letterSpacing="0.04em"
      mb="2px"
      whiteSpace="nowrap"
      overflow="hidden"
      textOverflow="ellipsis"
    >
      {text}
    </Box>
  );
}

interface ChartSvgProps {
  readonly width: number;
  readonly height: number;
  readonly innerH: number;
  readonly ariaLabel: string;
  readonly onMove: (e: React.MouseEvent<SVGSVGElement>) => void;
  readonly onLeave: () => void;
  readonly domainMin: number;
  readonly domainMax: number;
  readonly xFor: (v: number) => number;
  readonly histogram: { readonly bins: readonly HistogramBin[]; readonly maxCount: number };
  readonly kdePath: string | null;
  readonly hover: HoverState | null;
  readonly mean: number;
  readonly median: number;
  readonly baseline: number | null;
}

function ChartSvg(p: ChartSvgProps): React.ReactElement {
  return (
    <svg
      width={p.width}
      height={p.height}
      role="img"
      aria-label={p.ariaLabel}
      style={{ display: 'block', cursor: 'crosshair' }}
      onMouseMove={p.onMove}
      onMouseLeave={p.onLeave}
    >
      <XAxis
        domainMin={p.domainMin}
        domainMax={p.domainMax}
        width={p.width}
        height={p.height}
        xFor={p.xFor}
      />
      {p.histogram.bins.length === 0 ? (
        <EmptyHint width={p.width} height={p.height} />
      ) : (
        <Bars
          bins={p.histogram.bins}
          maxCount={p.histogram.maxCount}
          innerH={p.innerH}
          xFor={p.xFor}
          hover={p.hover}
        />
      )}
      {p.kdePath !== null && (
        <path d={p.kdePath} fill="none" stroke={KDE_STROKE} strokeWidth={1.5} />
      )}
      <RefLines
        xFor={p.xFor}
        height={p.height}
        mean={p.mean}
        median={p.median}
        baseline={p.baseline}
      />
      {p.hover !== null && <Crosshair cx={p.hover.cx} height={p.height} />}
    </svg>
  );
}

function computeHover(
  e: React.MouseEvent<SVGSVGElement>,
  bins: readonly HistogramBin[],
  innerW: number,
  xFor: (v: number) => number,
): HoverState | null {
  if (bins.length === 0) return null;
  const rect = e.currentTarget.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  if (mouseX < PAD.left || mouseX > PAD.left + innerW) return null;
  const bin = findBin(bins, mouseX, xFor);
  if (bin === null) return null;
  const cx = xFor((bin.x0 + bin.x1) / 2);
  return { bin, cx, mouseX, mouseY };
}

function buildKdePath(
  values: readonly number[],
  domainMin: number,
  domainMax: number,
  innerW: number,
  innerH: number,
  maxCount: number,
): string | null {
  if (values.length < 5 || maxCount <= 0) return null;
  const bw = silvermanBandwidth(values);
  if (bw <= 0) return null;
  const xs = linspace(domainMin, domainMax, KDE_SAMPLES);
  const ys = kde(values, xs, bw);
  const peak = ys.reduce((m, v) => (v > m ? v : m), 0);
  if (peak <= 0) return null;
  const domainSpan = Math.max(domainMax - domainMin, 1e-12);
  const parts: string[] = [];
  for (let i = 0; i < xs.length; i++) {
    const sx = PAD.left + (((xs[i] ?? 0) - domainMin) / domainSpan) * innerW;
    const sy = PAD.top + innerH - ((ys[i] ?? 0) / peak) * innerH;
    parts.push(`${i === 0 ? 'M' : 'L'}${sx.toFixed(2)},${sy.toFixed(2)}`);
  }
  return parts.join(' ');
}

function findBin(
  bins: readonly HistogramBin[],
  mouseX: number,
  xFor: (v: number) => number,
): HistogramBin | null {
  let best: HistogramBin | null = null;
  let bestDist = Infinity;
  for (const b of bins) {
    const cx = xFor((b.x0 + b.x1) / 2);
    const d = Math.abs(cx - mouseX);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}
