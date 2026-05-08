'use client';

/**
 * TERM.MAIN — keyboard-driven command surface, redesigned around the
 * CRT-terminal layout (docs/CRT Terminal - standalone.html) with the
 * project-specific differences requested by the user:
 *
 *   ┌─────────────────────────────────────────────┬─────────────────────┐
 *   │  qX//OS _  ASCII pixel logo + cursor        │  meta  N/M          │
 *   │                                             │  kline N/M          │
 *   │                                             │  MEM   xxxM         │
 *   │                                             │  FPS   xx           │
 *   ├─────────────────────────────────────────────┼─────────────────────┤
 *   │  xterm command surface                      │  ◆ <code> 90D       │
 *   │  (existing useTerminal bridge)              │  ▸ FOCUS  600519    │
 *   │                                             │  two-col metric grid│
 *   │                                             │  ◆ SENTIMENT (cache)│
 *   ├─────────────────────────────────────────────┴─────────────────────┤
 *   │  ● READY ·  Tab complete  ↑/↓ history  Ctrl+L clear  help cmds   │
 *   └───────────────────────────────────────────────────────────────────┘
 *
 * Differences vs. the HTML reference (per user request):
 *   - no INDEX ticker row
 *   - sys capsules (meta/kline/MEM/FPS) move to the header right column
 *     and lay out vertically
 *   - K-line moves to the TOP of the right dashboard
 *   - SIGNALS panel removed
 *   - tips bar replaces the previous F-keys bottom row, and replaces
 *     the in-xterm DECSTBM status row
 */

import { Box, Flex } from '@chakra-ui/react';
import { useCallback, useRef } from 'react';

import { useViewport } from '../../lib/hooks/use-viewport.js';
import { useUiStore } from '../../lib/stores/ui.store.js';

import { BigLogo } from './big-logo.js';
import { CrtOverlay } from './crt-overlay.js';
import { HeaderSysStat } from './header-sys-stat.js';
import { StockDashboard } from './stock-dashboard.js';
import { TipsBar } from './tips-bar.js';
import { useTerminal } from './use-terminal.js';

export function FeatTermMain(): React.ReactElement {
  const { mount, unmount, state } = useTerminal();
  const focusCode = useUiStore((s) => s.focusCode);
  const previewCode = peekListCode(state.active?.state) ?? focusCode;
  const lastNodeRef = useRef<HTMLDivElement | null>(null);
  // Mobile term mode is keyboard-driven and the soft keyboard already
  // claims half the viewport once the user focuses the prompt. Stack
  // the dashboard *above* the xterm at a compact height instead of
  // splitting horizontally — at <768 px the side-by-side layout left
  // the prompt with ~75 px (≈ 7 chars) of usable width.
  const { mode: vpMode } = useViewport();
  const isMobile = vpMode === 'mobile';

  const hostRefCallback = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node === lastNodeRef.current) return;
      if (lastNodeRef.current !== null) {
        unmount();
      }
      lastNodeRef.current = node;
      if (node !== null) {
        mount(node);
      }
    },
    [mount, unmount],
  );

  // Term mode is the whole-app surface in this layout — no FeatView
  // chrome. The BigLogo doubles as the exit affordance (click to
  // return to the regular workbench).
  return (
    <Flex
      direction="column"
      h="100%"
      minH="320px"
      bg="radial-gradient(ellipse at center, #08120c 0%, #04060a 65%, #020406 100%)"
      position="relative"
      overflow="hidden"
    >
      <CrtOverlay />

      {/* TOP — logo (left) + vertical sys.stat (right) */}
      <Flex
        position="relative"
        zIndex={2}
        px="18px"
        pt="10px"
        pb="8px"
        align="flex-start"
        justify="space-between"
        gap="20px"
        flexShrink={0}
      >
        <BigLogo />
        <HeaderSysStat />
      </Flex>

      {/* MAIN — xterm | dashboard. Mobile stacks vertically (dashboard
          on top, terminal below) so the prompt stays full-width above
          the soft keyboard; desktop keeps the side-by-side split. */}
      <Flex
        flex="1"
        minH={0}
        position="relative"
        zIndex={2}
        direction={isMobile ? 'column' : 'row'}
      >
        {isMobile && (
          <Box
            flexShrink={0}
            maxH="46vh"
            overflowY="auto"
            borderBottomWidth="1px"
            borderBottomColor="rgba(94, 255, 156, 0.12)"
          >
            <StockDashboard code={previewCode} />
          </Box>
        )}
        <Box
          ref={hostRefCallback}
          flex="1"
          minW={0}
          minH={0}
          position="relative"
          tabIndex={0}
          onClick={(): void => {
            lastNodeRef.current
              ?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
              ?.focus();
          }}
        />
        {!isMobile && (
          <Box w={{ base: '300px', xl: '360px' }} flexShrink={0} minH="100%">
            <StockDashboard code={previewCode} />
          </Box>
        )}
      </Flex>

      {/* BOTTOM — tips bar (driven by terminal widget hints) */}
      <Box position="relative" zIndex={2}>
        <TipsBar state={state} />
      </Box>
    </Flex>
  );
}

function peekListCode(activeState: unknown): string | null {
  if (activeState === null || typeof activeState !== 'object') return null;
  const ws = activeState as { idx?: unknown; visible?: unknown };
  if (typeof ws.idx !== 'number') return null;
  if (!Array.isArray(ws.visible)) return null;
  const item: unknown = ws.visible[ws.idx];
  if (item === null || typeof item !== 'object') return null;
  const code = (item as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
