'use client';

/**
 * Module 07 §workbench — EQTY (Equity workbench).
 *
 * Layout:
 *
 *   ┌──────────────┬───────────────────────────────┬──────────────┐
 *   │  SEC.LIST    │                               │              │
 *   │  (slider)    │                               │              │
 *   ├──────────────┤                               │              │
 *   │              │                               │              │
 *   │  EQ.LIST     │  EQ.CHART (with SCR.PAT       │  AI.SEC      │
 *   │              │  embedded inline)             │  AI.EQ       │
 *   │              │                               │              │
 *   │              │                               │  WATCH.LIVE  │
 *   │              │                               │              │
 *   └──────────────┴───────────────────────────────┴──────────────┘
 *
 * Column widths:
 *   left  — `leftWidth`  (resizable, persisted in idb); stacks
 *           SEC.LIST (horizontal chip slider) on top of EQ.LIST.
 *   mid   — flex-fills the gap; hosts EQ.CHART.
 *   right — `rightWidth` (resizable, persisted in idb).
 *
 * SEC.LIST is the chip strip from `feat-sec-list/`; its inner row keeps
 * its own `overflowX:auto`, so even when `leftWidth` is narrower than
 * the chip total the slider stays scrollable. SCR.PAT is embedded
 * inside EQ.CHART so the pattern range tracks the chart lifecycle.
 * TERM.MAIN no longer mounts here — it has its own top-level mode (see
 * AppShell).
 *
 * Columns flow top-to-bottom by their own content; rows across columns
 * intentionally do not align so minimize / restore in one column does
 * not reflow the others.
 */

import { Box, Flex } from '@chakra-ui/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useViewport } from '../../lib/hooks/use-viewport.js';
import { LAYOUT_LIMITS, useLayoutStore } from '../../lib/stores/layout.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { FeatEqChart } from '../feat-eq-chart/feat-eq-chart.js';
import { FeatAiSec } from '../feat-ai-sec/feat-ai-sec.js';
import { FeatMkt } from '../feat-mkt/feat-mkt.js';
import { FeatAiEq } from '../feat-ai-eq/feat-ai-eq.js';

import { EqtyModuleMobile } from './eqty-module-mobile.js';

export function EqtyModule(): React.ReactElement {
  const { mode } = useViewport();
  // Tablet falls through to the desktop three-column layout — the
  // existing min-widths (160 / 280) leave ~324px for the chart at
  // 768px viewport, which is the smallest tablet portrait we promise
  // to support. Mobile (<768px) needs a totally different paradigm
  // (single-Feat tab shell), handled in `EqtyModuleMobile`.
  if (mode === 'mobile') return <EqtyModuleMobile />;
  return <EqtyModuleDesktop />;
}

function EqtyModuleDesktop(): React.ReactElement {
  const code = useUiStore((s) => s.focusCode);
  const leftWidth = useLayoutStore((s) => s.leftWidth);
  const rightWidth = useLayoutStore((s) => s.rightWidth);
  const setLeftWidth = useLayoutStore((s) => s.setLeftWidth);
  const setRightWidth = useLayoutStore((s) => s.setRightWidth);

  return (
    <Flex h="100%" bg="line" gap="0" align="stretch">
      <Column width={`${String(leftWidth)}px`}>
        <FeatMkt />
      </Column>
      <Divider
        getNext={(dx, start): number => start + dx}
        startWidth={leftWidth}
        commit={setLeftWidth}
        min={LAYOUT_LIMITS.leftMin}
        max={LAYOUT_LIMITS.leftMax}
      />
      <Column flex="1">{code !== null && <FeatEqChart code={code} />}</Column>
      <Divider
        // Drag right edge: dragging *right* shrinks the right column.
        getNext={(dx, start): number => start - dx}
        startWidth={rightWidth}
        commit={setRightWidth}
        min={LAYOUT_LIMITS.rightMin}
        max={LAYOUT_LIMITS.rightMax}
      />
      <Column width={`${String(rightWidth)}px`}>
        <FeatAiSec />
        {code !== null && <FeatAiEq code={code} />}
      </Column>
    </Flex>
  );
}

interface ColumnProps {
  readonly width?: string;
  readonly flex?: string;
  readonly children: ReactNode;
}

function Column({ width, flex, children }: ColumnProps): React.ReactElement {
  return (
    <Box
      w={width}
      flex={flex}
      minW={0}
      h="100%"
      display="flex"
      flexDirection="column"
      gap="1px"
      bg="line"
    >
      {children}
    </Box>
  );
}

interface DividerProps {
  readonly startWidth: number;
  /** dx → drag delta in CSS px; returns the new column width. */
  readonly getNext: (dx: number, startWidth: number) => number;
  readonly commit: (px: number) => void;
  readonly min: number;
  readonly max: number;
}

/**
 * Hit-zone expansion — keeps the visual handle at 4 px (so columns
 * snap together at 4 px gaps) while letting trackpad / pen pointers
 * grab a 16 px strip without affecting layout. The wider strip on
 * `pointer: coarse` is the touch-target accommodation called out by
 * the UX plan §P0-4.
 */
const DIVIDER_HIT_BEFORE = {
  content: '""',
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: '-6px',
  right: '-6px',
} as const;
const DIVIDER_HIT_CSS = {
  '@media (pointer: coarse)': {
    '&::before': { left: '-10px', right: '-10px' },
  },
} as const;

/**
 * 4-px vertical drag handle. Mouse-down pins the starting column width
 * and listens to window-level mousemove/up; the column updates live
 * during the drag, and the final value is clamped + persisted.
 */
function Divider({ startWidth, getNext, commit, min, max }: DividerProps): React.ReactElement {
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWRef = useRef(startWidth);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent): void => {
      const dx = e.clientX - startXRef.current;
      const next = clamp(getNext(dx, startWRef.current), min, max);
      commit(next);
    };
    const onUp = (): void => {
      setDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, getNext, commit, min, max]);

  return (
    <Box
      onMouseDown={(e): void => {
        startXRef.current = e.clientX;
        startWRef.current = startWidth;
        setDragging(true);
      }}
      role="separator"
      aria-orientation="vertical"
      aria-label="resize column"
      w="4px"
      h="100%"
      bg={dragging ? 'accent' : 'line'}
      cursor="col-resize"
      flexShrink={0}
      position="relative"
      _hover={{ bg: 'accent' }}
      transition="background 120ms ease"
      _before={DIVIDER_HIT_BEFORE}
      css={DIVIDER_HIT_CSS}
    />
  );
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
