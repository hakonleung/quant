'use client';

/**
 * TERM.MAIN — keyboard-driven command surface, redesigned around the
 * CRT-terminal layout (docs/CRT Terminal - standalone.html):
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │  qX//OS_  (big block-letter logo)                             │
 *   ├───────────────────────────────────────────────────────────────┤
 *   │  SSE  IDB  meta  kline  MEM  FPS                  hh:mm:ss   │
 *   ├──────────────────────────────────────────────┬────────────────┤
 *   │  xterm command surface                       │  FOCUS panel   │
 *   │  (existing useTerminal bridge)               │  · meta        │
 *   │                                              │  · sentiment   │
 *   │                                              │  · 90D kline   │
 *   └──────────────────────────────────────────────┴────────────────┘
 *
 * The xterm host preserves its own bottom status row (rendered via
 * DECSTBM in `use-terminal.ts`); the right-side dashboard is plain JSX.
 *
 * The dashboard "preview code" is computed by peeking into the active
 * widget's state — a generic `selectableList` exposes `idx` + `visible`,
 * and any item with a `code: string` field becomes the preview. Falls
 * back to the global `focusCode` in `ui.store` when no list is active.
 */

import { Box, Flex } from '@chakra-ui/react';
import { useCallback, useRef } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from '../feat-view/feat-view.js';

import { BigLogo } from './big-logo.js';
import { CrtOverlay } from './crt-overlay.js';
import { StockDashboard } from './stock-dashboard.js';
import { TermSysRow } from './sys-row.js';
import { useTerminal } from './use-terminal.js';

export function FeatTermMain(): React.ReactElement {
  const { mount, unmount, state } = useTerminal();
  const focusCode = useUiStore((s) => s.focusCode);
  const previewCode = peekListCode(state.active?.state) ?? focusCode;
  const lastNodeRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <FeatView feat={Feat.Terminal}>
      <Flex
        direction="column"
        h="100%"
        minH="320px"
        bg="term.bg"
        position="relative"
        overflow="hidden"
      >
        <CrtOverlay />

        {/* TOP: big logo + SYS row */}
        <Box position="relative" zIndex={1} px="18px" pt="10px" pb="6px" flexShrink={0}>
          <BigLogo />
        </Box>
        <Box position="relative" zIndex={1}>
          <TermSysRow />
        </Box>

        {/* MAIN: xterm | dashboard */}
        <Flex flex="1" minH={0} position="relative" zIndex={1}>
          <Box
            ref={hostRefCallback}
            flex="1"
            minW={0}
            position="relative"
            tabIndex={0}
            onClick={(): void => {
              lastNodeRef.current
                ?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
                ?.focus();
            }}
          />
          <Box w={{ base: '260px', xl: '320px' }} flexShrink={0} minH="100%">
            <StockDashboard code={previewCode} />
          </Box>
        </Flex>
      </Flex>
    </FeatView>
  );
}

/**
 * Pull a stock code out of the active widget's state if it looks like a
 * `selectableList` whose highlighted row carries a `code` string. Pure
 * structural narrowing so we don't have to change widget contracts.
 */
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
