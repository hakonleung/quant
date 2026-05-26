'use client';

/**
 * EQTY workbench layout — floating-island three-column shell.
 *
 * Each tile in the diagram is its own `<FeatView>`; the columns are
 * Flex containers with a 4 px gap so the page wallpaper reads between
 * the panes. The 2026-05 split broke the older combined MKT and
 * EQ.CHART panes into independent islands:
 *
 *   ┌────────────┬──────────────────┬───────────┐
 *   │   MKT      │   EQ (kline)     │  AI.SEC   │
 *   ├────────────┤                  │           │
 *   │ SEARCH ┃   ├──────────────────┤           │
 *   │ DSL+BT ┃   │   EQ.INFO        │           │
 *   ├────────────┤                  ├───────────┤
 *   │  EQ.LIST   ├──────────────────┤  AI.EQ    │
 *   │            │   PAT            │           │
 *   └────────────┴──────────────────┴───────────┘
 *
 * Left column tile #2 is conditional on the active sector kind:
 *   - user sector   → `<FeatScrNl>` (SEARCH; pick adds to the sector)
 *   - dynamic sector → `<FeatScrDsl>` + `<FeatBtEval>` stacked
 *   - All / none    → nothing (saves vertical space)
 *
 * Columns flow top-to-bottom by their own content; rows across
 * columns intentionally do not align so minimize / restore in one
 * column does not reflow the others.
 */

import { Box, Flex } from '@chakra-ui/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useViewport } from '../../lib/hooks/use-viewport.js';
import { LAYOUT_LIMITS, useLayoutStore } from '../../lib/stores/layout.store.js';
import { useSectorsStore } from '../../lib/stores/sectors.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import type { UniverseStock } from '../../lib/hooks/use-stock-universe.js';
import { FeatAiEq } from '../feat-ai-eq/feat-ai-eq.js';
import { FeatAiSec } from '../feat-ai-sec/feat-ai-sec.js';
import { FeatBtEval } from '../feat-bt-eval/feat-bt-eval.js';
import { FeatEqChart } from '../feat-eq-chart/feat-eq-chart.js';
import { FeatEqInfo } from '../feat-eq-info/feat-eq-info.js';
import { FeatEqList } from '../feat-eq-list/feat-eq-list.js';
import { FeatMkt } from '../feat-mkt/feat-mkt.js';
import { FeatScrDsl } from '../feat-scr-dsl/feat-scr-dsl.js';
import { FeatScrNl } from '../feat-scr-nl/feat-scr-nl.js';
import { FeatScrPat } from '../feat-scr-pat/feat-scr-pat.js';

import { EqtyModuleMobile } from './eqty-module-mobile.js';

export function EqtyModule(): React.ReactElement {
  const { mode } = useViewport();
  // Tablet falls through to the desktop three-column layout. Mobile
  // (<768px) needs a totally different paradigm (single-Feat tab
  // shell), handled in `EqtyModuleMobile`.
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
    // Liquid Glass floating-island workbench. Outer container is
    // transparent (the body ambient mesh shows through), padding +
    // gap separate each pane so the canvas reads BETWEEN them too —
    // panes look like floating glass tiles, not flush columns.
    <Flex h="100%" bg="transparent" gap="4px" p="4px" align="stretch">
      <Column width={`${String(leftWidth)}px`}>
        <FeatMkt />
        <ScrPanesForActiveSector />
        <FeatEqList />
      </Column>
      <Divider
        getNext={(dx, start): number => start + dx}
        startWidth={leftWidth}
        commit={setLeftWidth}
        min={LAYOUT_LIMITS.leftMin}
        max={LAYOUT_LIMITS.leftMax}
      />
      <Column flex="1">
        {code !== null && <FeatEqChart code={code} />}
        <FeatEqInfo />
        <FeatScrPat />
      </Column>
      <Divider
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

/**
 * Mounts the screening tiles paired with the active sector kind.
 * User sector → SEARCH (add-to-sector). Dynamic sector → DSL editor
 * + BT (event-study backtest). Skipped for the synthetic "All" sector
 * or when nothing is selected — no point showing screening surfaces
 * with no target.
 */
function ScrPanesForActiveSector(): React.ReactElement | null {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const sectors = useSectorsStore((s) => s.sectors);
  const sector = sectors.find((s) => s.id === activeSectorId) ?? null;
  if (sector === null) return null;
  if (sector.kind === 'user') return <SearchAddToActiveSector />;
  // SectorKind is currently `'user' | 'dynamic'`, so this is the
  // exhaustive other branch — kept explicit (not `else`) so a future
  // third kind shows up here as a compile error.
  return (
    <>
      <FeatScrDsl />
      <FeatBtEval />
    </>
  );
}

/**
 * SEARCH pane wired up to add the picked stock to the active user
 * sector. The dedicated `FeatScrNl` widget owns the input + dropdown
 * + batch-paste UI; this thin wrapper only supplies the callbacks.
 *
 * Only mounted when `ScrPanesForActiveSector` has already verified
 * the active sector is a user sector, so no further fallback is
 * needed here.
 */
function SearchAddToActiveSector(): React.ReactElement | null {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const sectors = useSectorsStore((s) => s.sectors);
  const upsert = useSectorsStore((s) => s.upsert);
  const sector = sectors.find((s) => s.id === activeSectorId) ?? null;
  if (sector?.kind !== 'user') return null;
  const market = sector.market;
  const onPick = (stock: UniverseStock): void => {
    if (sector.codes.includes(stock.code)) return;
    const next = [...sector.codes, stock.code];
    upsert({ ...sector, codes: next, count: next.length });
  };
  const onBatchPick = (stocks: readonly UniverseStock[]): void => {
    const existing = new Set(sector.codes);
    const next = [...sector.codes];
    for (const s of stocks) {
      if (existing.has(s.code)) continue;
      existing.add(s.code);
      next.push(s.code);
    }
    if (next.length === sector.codes.length) return;
    upsert({ ...sector, codes: next, count: next.length });
  };
  // `marketFilter` is required-or-omitted (`exactOptionalPropertyTypes`),
  // so spread conditionally — never assign `undefined` to it.
  return (
    <FeatScrNl
      {...(market !== undefined ? { marketFilter: market } : {})}
      onPick={onPick}
      onBatchPick={onBatchPick}
    />
  );
}

interface ColumnProps {
  readonly width?: string;
  readonly flex?: string;
  readonly children: ReactNode;
}

function Column({ width, flex, children }: ColumnProps): React.ReactElement {
  return (
    // Floating-island column — transparent bg + 4px gap so stacked
    // panes within a column also separate (ambient canvas peeks
    // between them).
    <Box
      w={width}
      flex={flex}
      minW={0}
      h="100%"
      display="flex"
      flexDirection="column"
      gap="4px"
      bg="transparent"
      overflowY="auto"
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
      // Floating-island gap between columns — drag handle is now
      // visually invisible (transparent) but still keeps the 4px hit
      // zone + accent flash on hover/drag to telegraph the resize
      // affordance.
      w="4px"
      h="100%"
      bg={dragging ? 'accent' : 'transparent'}
      borderRadius="pill"
      cursor="col-resize"
      flexShrink={0}
      position="relative"
      _hover={{ bg: 'accent', opacity: 0.5 }}
      transition="background 120ms ease, opacity 120ms ease"
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
