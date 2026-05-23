'use client';

/**
 * TERM.MAIN — keyboard-driven command surface, redesigned around the
 * CRT-terminal layout. Consumes the shared `TermConsole` component for
 * the xterm pane; this file owns only the surrounding chrome (logo,
 * sys-stat header, stock dashboard, tips bar) and the mobile stack
 * layout. See `components/term-console/` for the engine + xterm bridge.
 */

import { Box, Flex } from '@chakra-ui/react';
import { initialState, type TerminalState } from '@quant/terminal';
import { useState } from 'react';

import { useViewport } from '../../lib/hooks/use-viewport.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { TermConsole } from '../term-console/index.js';

import { BigLogo } from './big-logo.js';
import { CrtOverlay } from './crt-overlay.js';
import { HeaderSysStat } from './header-sys-stat.js';
import { StockDashboard } from './stock-dashboard.js';
import { TipsBar } from './tips-bar.js';

export function FeatTermMain(): React.ReactElement {
  const [state, setState] = useState<TerminalState>(initialState);
  const focusCode = useUiStore((s) => s.focusCode);
  const previewCode = peekListCode(state.active?.state) ?? focusCode;
  const { mode: vpMode } = useViewport();
  const isMobile = vpMode === 'mobile';

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
        <Box flex="1" minW={0} minH={0} position="relative">
          <TermConsole fontSize={15} autoFocus onState={setState} />
        </Box>
        {!isMobile && (
          <Box w={{ base: '300px', xl: '360px' }} flexShrink={0} minH="100%">
            <StockDashboard code={previewCode} />
          </Box>
        )}
      </Flex>

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
