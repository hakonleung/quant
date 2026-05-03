'use client';

/**
 * Module 07 §workbench — EQTY (Equity workbench).
 *
 * Three independent column streams (with draggable dividers between
 * left / center and center / right):
 *   left   — Sectors (002) + Blacklist (003)
 *   middle — List (001) of stocks under the active sector
 *   right  — TaskQueue (300) always; per-stock 101/102/103/200 mount
 *            once a row is clicked in the list
 *
 * Columns flow top-to-bottom by their own content; rows across columns
 * intentionally do not align so minimize / restore in one column does
 * not reflow the others. Side-column widths persist via the layout
 * store (idb-backed) and survive reloads.
 */

import { Box, Flex } from '@chakra-ui/react';
import type { Sentiment } from '@quant/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { LAYOUT_LIMITS, useLayoutStore } from '../../lib/stores/layout.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { ChartPanel } from '../eqty/chart-panel.js';
import { ListPanel } from '../eqty/list-panel.js';
import { PatternMatchPanel } from '../eqty/pattern-match-panel.js';
import { SectorSentimentPanel } from '../eqty/sector-sentiment-panel.js';
import { SectorsPanel } from '../eqty/sectors-panel.js';
import { SlackPushPanel } from '../eqty/slack-push-panel.js';
import { StdoutPanel } from '../eqty/stdout-panel.js';

export function EqtyModule(): React.ReactElement {
  const code = useUiStore((s) => s.focusCode);
  const [sentiment, setSentiment] = useState<Sentiment | null>(null);
  const leftWidth = useLayoutStore((s) => s.leftWidth);
  const rightWidth = useLayoutStore((s) => s.rightWidth);
  const setLeftWidth = useLayoutStore((s) => s.setLeftWidth);
  const setRightWidth = useLayoutStore((s) => s.setRightWidth);

  return (
    <Flex h="100%" gap="0" bg="line" align="stretch">
      <Column width={`${String(leftWidth)}px`}>
        <SectorsPanel />
      </Column>
      <Divider
        side="left"
        getNext={(dx, start): number => start + dx}
        startWidth={leftWidth}
        commit={setLeftWidth}
        min={LAYOUT_LIMITS.leftMin}
        max={LAYOUT_LIMITS.leftMax}
      />
      <Column flex="1">
        <ListPanel />
        <PatternMatchPanel />
      </Column>
      <Divider
        side="right"
        // Drag right edge: dragging *right* shrinks the right column.
        getNext={(dx, start): number => start - dx}
        startWidth={rightWidth}
        commit={setRightWidth}
        min={LAYOUT_LIMITS.rightMin}
        max={LAYOUT_LIMITS.rightMax}
      />
      <Column width={`${String(rightWidth)}px`}>
        {code !== null && <ChartPanel code={code} />}
        <SectorSentimentPanel />
        {code !== null && (
          <>
            <StdoutPanel code={code} onResult={setSentiment} />
            <SlackPushPanel
              code={code}
              sentimentScore={sentiment?.score ?? null}
              theme={sentiment?.theme ?? null}
            />
          </>
        )}
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
  readonly side: 'left' | 'right';
  readonly startWidth: number;
  /** dx → drag delta in CSS px; returns the new column width. */
  readonly getNext: (dx: number, startWidth: number) => number;
  readonly commit: (px: number) => void;
  readonly min: number;
  readonly max: number;
}

/**
 * 4-px vertical drag handle. Mouse-down pins the starting column width
 * and listens to window-level mousemove/up; the column updates live
 * during the drag, and the final value is clamped + persisted.
 */
function Divider({ side, startWidth, getNext, commit, min, max }: DividerProps): React.ReactElement {
  void side;
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
      w="4px"
      h="100%"
      bg={dragging ? 'accent' : 'line'}
      cursor="col-resize"
      flexShrink={0}
      _hover={{ bg: 'accent' }}
      transition="background 120ms ease"
    />
  );
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
