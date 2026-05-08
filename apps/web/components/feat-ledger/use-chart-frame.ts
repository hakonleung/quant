'use client';

/**
 * Stateful hooks for `LedgerChart` — width tracking, viewport state
 * (zoom + pan + auto-fit), and pointer hover. Kept out of the
 * presentational chart file so each piece stays under the per-
 * function size budget.
 */

import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import {
  clampViewport,
  DEFAULT_VIEWPORT,
  indexAtX,
  maxPanPx,
  type ChartViewport,
  type VisibleSlice,
} from '../../lib/fp/chart-view.js';
import { INNER_BOTTOM, INNER_TOP, PRICE_AXIS_W } from './ledger-chart-layers.js';

export function useResizeWidth(initial: number): {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly width: number;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.round(w));
    });
    ro.observe(el);
    return (): void => {
      ro.disconnect();
    };
  }, []);
  return { ref, width };
}

interface ViewportArgs {
  readonly seriesCount: number;
  readonly seriesKey: string;
  readonly innerW: number;
  readonly targetEl: RefObject<HTMLDivElement | null>;
}

interface ViewportApi {
  readonly vp: ChartViewport;
  readonly onMouseDown: (e: React.MouseEvent<SVGSVGElement>) => void;
  readonly isDragging: boolean;
}

export function useChartViewport({
  seriesCount,
  seriesKey,
  innerW,
  targetEl,
}: ViewportArgs): ViewportApi {
  const [vp, setVp] = useState<ChartViewport>(() => fitAllBars(720, seriesCount));
  const [isDragging, setIsDragging] = useState(false);
  useAutoFit({ vp, setVp, seriesKey, seriesCount, innerW });
  useReclampPan({ vp, setVp, seriesCount, innerW });
  const onMouseDown = useDragPan({
    vp,
    setVp,
    setIsDragging,
    seriesCount,
    innerW,
  });
  useWheelZoom({ vp, setVp, seriesCount, innerW, targetEl });
  return { vp, onMouseDown, isDragging };
}

interface FitArgs {
  readonly vp: ChartViewport;
  readonly setVp: (next: ChartViewport) => void;
  readonly seriesKey: string;
  readonly seriesCount: number;
  readonly innerW: number;
}

function useAutoFit({ setVp, seriesKey, seriesCount, innerW }: FitArgs): void {
  // First paint per (series, width-known) tuple. Re-fit on series swap
  // (count or first/last date change) so a tab switch doesn't strand
  // the viewport at a stale zoom.
  const lastFitRef = useRef<{ key: string; widthKnown: boolean }>({ key: '', widthKnown: false });
  useEffect(() => {
    if (innerW <= 0 || seriesCount === 0) return;
    const last = lastFitRef.current;
    if (last.key === seriesKey && last.widthKnown) return;
    lastFitRef.current = { key: seriesKey, widthKnown: true };
    setVp(fitAllBars(innerW, seriesCount));
  }, [seriesKey, innerW, seriesCount, setVp]);
}

/**
 * Like `fitVisibleViewport` but targets the *entire* series rather
 * than the shared `DEFAULT_VISIBLE_BARS` heuristic — the ledger chart
 * is a small, finite-history view (rarely > 100 days), so showing all
 * data on first paint is the right default. Wheel-zoom/drag still
 * apply for users who want to zoom in.
 */
function fitAllBars(viewWidth: number, totalBars: number): ChartViewport {
  if (viewWidth <= 0 || totalBars <= 0) return DEFAULT_VIEWPORT;
  // candleW + gap = stride; gap ≈ 0.25 * candleW → stride ≈ 1.25 * candleW.
  const stride = viewWidth / totalBars;
  return clampViewport({ candleW: stride / 1.25, gap: 0, panPx: 0 });
}

interface ReclampArgs {
  readonly vp: ChartViewport;
  readonly setVp: (next: ChartViewport) => void;
  readonly seriesCount: number;
  readonly innerW: number;
}

function useReclampPan({ vp, setVp, seriesCount, innerW }: ReclampArgs): void {
  useEffect(() => {
    if (innerW <= 0 || seriesCount === 0) return;
    const upper = maxPanPx(seriesCount, vp, innerW);
    if (vp.panPx > upper) setVp(clampViewport({ ...vp, panPx: upper }));
  }, [vp, seriesCount, innerW, setVp]);
}

interface DragArgs {
  readonly vp: ChartViewport;
  readonly setVp: (next: ChartViewport) => void;
  readonly setIsDragging: (b: boolean) => void;
  readonly seriesCount: number;
  readonly innerW: number;
}

function useDragPan({
  vp,
  setVp,
  setIsDragging,
  seriesCount,
  innerW,
}: DragArgs): (e: React.MouseEvent<SVGSVGElement>) => void {
  const dragRef = useRef<{ startClientX: number; startPan: number } | null>(null);
  // Bind window listeners so the gesture survives leaving the SVG and
  // mouse-up always lands.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = dragRef.current;
      if (drag === null) return;
      const dx = e.clientX - drag.startClientX;
      // Cursor moves right (dx > 0) → reveal older bars on the left,
      // i.e. *decrease* panPx (undo previous pan).
      const upper = maxPanPx(seriesCount, vp, innerW);
      const next = Math.min(upper, Math.max(0, drag.startPan - dx));
      setVp(clampViewport({ ...vp, panPx: next }));
    };
    const onUp = (): void => {
      if (dragRef.current === null) return;
      dragRef.current = null;
      setIsDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [vp, seriesCount, innerW, setVp, setIsDragging]);
  return useCallback(
    (e: React.MouseEvent<SVGSVGElement>): void => {
      dragRef.current = { startClientX: e.clientX, startPan: vp.panPx };
      setIsDragging(true);
    },
    [vp.panPx, setIsDragging],
  );
}

interface WheelArgs {
  readonly vp: ChartViewport;
  readonly setVp: (next: ChartViewport) => void;
  readonly seriesCount: number;
  readonly innerW: number;
  readonly targetEl: RefObject<HTMLDivElement | null>;
}

function useWheelZoom({ vp, setVp, seriesCount, innerW, targetEl }: WheelArgs): void {
  // Mirror state into a ref so the listener (passive: false) doesn't
  // need to re-bind on every viewport tick.
  const stateRef = useRef({ vp, seriesCount, innerW });
  stateRef.current = { vp, seriesCount, innerW };
  useEffect(() => {
    const el = targetEl.current;
    if (el === null) return;
    const handler = (e: WheelEvent): void => {
      e.preventDefault();
      const s = stateRef.current;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const next = clampViewport({ ...s.vp, candleW: s.vp.candleW * factor });
      const upper = maxPanPx(s.seriesCount, next, s.innerW);
      setVp({ ...next, panPx: Math.min(upper, next.panPx) });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return (): void => {
      el.removeEventListener('wheel', handler);
    };
  }, [targetEl, setVp]);
}

interface HoverArgs {
  readonly slice: VisibleSlice;
  readonly seriesCount: number;
  readonly innerW: number;
  readonly isDragging: boolean;
}

interface HoverState {
  readonly idx: number;
  readonly cursorY: number;
}

export interface HoverApi {
  readonly state: HoverState | null;
  readonly onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void;
  readonly onPointerLeave: () => void;
  readonly onMouseUp: (e: React.MouseEvent<SVGSVGElement>) => void;
}

export function useChartHover({
  slice,
  seriesCount,
  innerW,
  isDragging,
}: HoverArgs): HoverApi {
  const [state, setState] = useState<HoverState | null>(null);

  const pickIdx = useCallback(
    (clientX: number, rect: DOMRect): number | null => {
      if (rect.width === 0) return null;
      const mx = clientX - rect.left - PRICE_AXIS_W;
      if (mx < 0 || mx > innerW) return null;
      return indexAtX(mx, slice, seriesCount);
    },
    [slice, innerW, seriesCount],
  );

  const apply = useCallback(
    (clientX: number, clientY: number, rect: DOMRect): void => {
      const my = clientY - rect.top;
      if (my < INNER_TOP || my > INNER_BOTTOM) {
        setState(null);
        return;
      }
      const idx = pickIdx(clientX, rect);
      if (idx === null) {
        setState(null);
        return;
      }
      setState({ idx, cursorY: my });
    },
    [pickIdx],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): void => {
      if (isDragging) return;
      apply(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    },
    [apply, isDragging],
  );
  const onPointerLeave = useCallback((): void => {
    setState(null);
  }, []);
  const onMouseUp = useCallback(
    (e: React.MouseEvent<SVGSVGElement>): void => {
      // The drag handler clears its ref on mouseup; treat any mouseup
      // that wasn't a drag as a click-to-pin gesture. We don't track a
      // separate `moved` flag here — a small drag still updates hover
      // by X, which is acceptable.
      apply(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    },
    [apply],
  );

  return { state, onPointerMove, onPointerLeave, onMouseUp };
}
