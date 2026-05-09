'use client';

/**
 * Pointer-event handler bundle for {@link ChartCanvas}.
 *
 * Pulls the drag-pan / pinch-zoom / hover-crosshair / tap-commit
 * gesture state machine out of the component file so the JSX layer
 * stays under the 400-line ceiling. The hook returns a stable handler
 * set + a ref that signals an active drag (used for the cursor swap).
 *
 * Pointer events unify mouse / pen / touch:
 *   - Single pointer: drag pans the viewport.
 *   - Two pointers: pinch adjusts `vp.candleW`, anchoring the bar
 *     under the gesture midpoint so the user zooms *into* what they
 *     hold.
 *   - Touch never produces a hover crosshair — touch has no hover
 *     semantics, so a stuck crosshair after a tap would look like an
 *     artifact.
 *   - Tap that didn't move (≤2 px) commits as a click on the bar
 *     under the pointer.
 */

import { useRef, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';

import {
  clampViewport,
  indexAtX,
  maxPanPx,
  type ChartViewport,
  type VisibleSlice,
} from '../../lib/fp/chart-view.js';
import { useSettingsStore } from '../../lib/stores/settings.store.js';

interface DragState {
  startClientX: number;
  startPan: number;
  moved: boolean;
}

interface PinchState {
  startDist: number;
  startCandleW: number;
  /** Bar index under the pinch midpoint when the gesture began. */
  anchorIdx: number | null;
  anchorScreenX: number;
}

export interface ChartPointerHandlers {
  readonly onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerCancel: (e: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerLeave: (e: ReactPointerEvent<SVGSVGElement>) => void;
  /** True while a drag-pan gesture is active — drives the cursor swap. */
  readonly dragRef: MutableRefObject<DragState | null>;
}

export interface ChartPointerArgs {
  readonly interactive: boolean;
  readonly bars: { readonly length: number };
  readonly slice: VisibleSlice;
  readonly vp: ChartViewport;
  readonly setVp: (next: ChartViewport) => void;
  readonly innerW: number;
  readonly priceH: number;
  readonly priceAxisW: number;
  readonly inverseY: (y: number) => number;
  readonly setHoverIdx?: (n: number | null) => void;
  readonly setHoverPrice?: (p: number | null) => void;
  readonly onBarClick?: (idx: number) => void;
}

function pointerDistance(
  a: { readonly clientX: number; readonly clientY: number },
  b: { readonly clientX: number; readonly clientY: number },
): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

export function useChartPointer(args: ChartPointerArgs): ChartPointerHandlers {
  const {
    interactive,
    bars,
    slice,
    vp,
    setVp,
    innerW,
    priceH,
    priceAxisW,
    inverseY,
    setHoverIdx,
    setHoverPrice,
    onBarClick,
  } = args;

  const dragRef = useRef<DragState | null>(null);
  const pinchRef = useRef<PinchState | null>(null);
  const pointersRef = useRef<Map<number, { clientX: number; clientY: number }>>(new Map());
  // `natural` (default): cursor and panned content move in the *same*
  // direction (drag left → reveal older bars on the left). `inverted`
  // mirrors the pre-2026-05 behaviour for users who prefer it.
  const dragDirection = useSettingsStore((s) => s.dragDirection);
  const dragSign = dragDirection === 'natural' ? -1 : 1;

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);

    if (pointersRef.current.size === 2) {
      dragRef.current = null;
      const [a, b] = [...pointersRef.current.values()];
      if (a !== undefined && b !== undefined) {
        const startDist = pointerDistance(a, b);
        if (startDist > 0) {
          const rect = e.currentTarget.getBoundingClientRect();
          const midX = (a.clientX + b.clientX) / 2 - rect.left - priceAxisW;
          pinchRef.current = {
            startDist,
            startCandleW: vp.candleW,
            anchorIdx: indexAtX(midX, slice, bars.length),
            anchorScreenX: midX,
          };
        }
      }
      return;
    }
    if (pointersRef.current.size > 2) return;

    dragRef.current = {
      startClientX: e.clientX,
      startPan: vp.panPx,
      moved: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    const rec = pointersRef.current.get(e.pointerId);
    if (rec !== undefined) {
      pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    }

    const pinch = pinchRef.current;
    if (pinch !== null && pointersRef.current.size === 2) {
      handlePinchMove(pinch, pointersRef.current, vp, setVp, bars.length, innerW);
      return;
    }

    const drag = dragRef.current;
    if (drag !== null) {
      const dx = e.clientX - drag.startClientX;
      if (Math.abs(dx) > 2) drag.moved = true;
      const upper = maxPanPx(bars.length, vp, innerW);
      const nextPan = Math.min(upper, Math.max(0, drag.startPan + dragSign * dx));
      setVp(clampViewport({ ...vp, panPx: nextPan }));
      return;
    }

    if (e.pointerType === 'touch') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - priceAxisW;
    const y = e.clientY - rect.top;
    if (x >= 0 && y >= 0 && y <= priceH) {
      const idx = indexAtX(x, slice, bars.length);
      setHoverIdx?.(idx);
      setHoverPrice?.(inverseY(y));
    } else {
      setHoverIdx?.(null);
      setHoverPrice?.(null);
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    const wasPinching = pinchRef.current !== null;
    pointersRef.current.delete(e.pointerId);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }

    if (pointersRef.current.size < 2) pinchRef.current = null;

    if (wasPinching && pointersRef.current.size === 1) {
      const [remaining] = [...pointersRef.current.values()];
      if (remaining !== undefined) {
        dragRef.current = {
          startClientX: remaining.clientX,
          startPan: vp.panPx,
          moved: true,
        };
      }
      return;
    }

    const drag = dragRef.current;
    if (pointersRef.current.size === 0) dragRef.current = null;
    if (drag === null || drag.moved) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - priceAxisW;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || y > priceH) return;
    const idx = indexAtX(x, slice, bars.length);
    if (idx === null) return;
    onBarClick?.(idx);
  };

  const onPointerCancel = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) dragRef.current = null;
  };

  const onPointerLeave = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!interactive) return;
    if (e.pointerType === 'touch') return;
    setHoverIdx?.(null);
    setHoverPrice?.(null);
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave,
    dragRef,
  };
}

/** Pinch-driven zoom: scales `candleW` by finger-distance ratio and
 *  pins the bar under the original midpoint to its starting screen X. */
function handlePinchMove(
  pinch: PinchState,
  pointers: ReadonlyMap<number, { clientX: number; clientY: number }>,
  vp: ChartViewport,
  setVp: (next: ChartViewport) => void,
  totalBars: number,
  innerW: number,
): void {
  const [a, b] = [...pointers.values()];
  if (a === undefined || b === undefined) return;
  const dist = pointerDistance(a, b);
  if (dist <= 0) return;
  const ratio = dist / pinch.startDist;
  const nextCandleW = pinch.startCandleW * ratio;
  const nextVp = clampViewport({ ...vp, candleW: nextCandleW });
  if (pinch.anchorIdx !== null) {
    const stride = nextVp.candleW + nextVp.gap;
    const totalSpan = totalBars * stride - nextVp.gap;
    const upper = Math.max(0, totalSpan - innerW);
    const desiredFirstX = pinch.anchorScreenX - pinch.anchorIdx * stride;
    const desiredLatestRightX = desiredFirstX + totalBars * stride - nextVp.gap;
    const nextPan = Math.min(upper, Math.max(0, desiredLatestRightX - innerW));
    setVp({ ...nextVp, panPx: nextPan });
  } else {
    setVp(nextVp);
  }
}
