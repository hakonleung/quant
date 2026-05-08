'use client';

/**
 * Top-level chrome switch.
 *
 * In `regular` mode the shell mounts the TopBar + the route's
 * `children` (EqtyModule, which is the three-column workbench). In
 * `term` mode the chrome collapses entirely and only FeatTermMain is
 * mounted at full viewport — the user requested a clean keyboard-only
 * surface. The toggle is driven by the persisted `appMode` slice in
 * `useLayoutStore`.
 *
 * Lives at the layout boundary so children only mount when the mode
 * actually shows them. That keeps the workbench's TanStack-Query
 * subscriptions and zustand selectors from running while the user is
 * driving the terminal.
 */

import { Box } from '@chakra-ui/react';
import type { ReactNode } from 'react';

import { useLayoutStore } from '../../lib/stores/layout.store.js';
import { FeatTermMain } from '../feat-term-main/feat-term-main.js';

import { TopBar } from './top-bar.js';

interface AppShellProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellProps): React.ReactElement {
  const mode = useLayoutStore((s) => s.appMode);

  if (mode === 'term') {
    return (
      <Box h="100vh" w="100vw" bg="bg" overflow="hidden">
        <FeatTermMain />
      </Box>
    );
  }

  return (
    <Box as="main" h="100vh" bg="bg" display="flex" flexDirection="column" overflow="hidden">
      <TopBar />
      <Box flex="1" minH={0}>
        {children}
      </Box>
    </Box>
  );
}
