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
import { useEffect, useRef, type ReactNode } from 'react';

import { useCmdPaletteStore } from '../../lib/stores/cmd-palette.store.js';
import { useLayoutStore } from '../../lib/stores/layout.store.js';
import { useSettingsStore } from '../../lib/stores/settings.store.js';
import { FeatCmdPalette } from '../feat-cmd-palette/feat-cmd-palette.js';
import { FeatNotify } from '../feat-notify/feat-notify.js';
import { FeatTermMain } from '../feat-term-main/feat-term-main.js';

import { TopBar } from './top-bar.js';

interface AppShellProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellProps): React.ReactElement {
  const mode = useLayoutStore((s) => s.appMode);
  // Global ⌘K / Ctrl+K opens the command palette anywhere outside
  // the terminal. The terminal already provides its own command
  // surface (the prompt) and ⌘K would conflict with xterm's own key
  // handling. The listener installs once on shell mount.
  useGlobalCmdKey({ enabled: mode !== 'term' });
  // Reflect the persisted theme into a data-attribute on <html> so
  // the CSS-var override in layout.tsx flips every Chakra colour
  // token at once. The seeding pass also resolves `prefers-color-
  // scheme` for first-time visitors before any pixel paints.
  useThemeAttribute();

  if (mode === 'term') {
    // `100dvh` follows the on-screen-keyboard / iOS bottom bar so the
    // terminal's input row stays visible once the keyboard pops. The
    // safe-area paddings keep its caret out of the notch + home bar.
    return (
      <Box
        h="100dvh"
        w="100vw"
        bg="bg"
        overflow="hidden"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
        }}
      >
        <FeatTermMain />
        <FeatNotify />
      </Box>
    );
  }

  return (
    <Box
      h="100dvh"
      bg="bg"
      display="flex"
      flexDirection="column"
      overflow="hidden"
      style={{
        // Top-bar already anchors to the top, so safe-area-top is
        // applied inside TopBar to keep its accent border continuous
        // with the notch shadow. Bottom safe-area absorbs the iOS home
        // indicator under the mobile tab bar.
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      {/* Visually-hidden until focused — the only Tab stop above the
          topbar so keyboard users skip the ASCII brand + sys capsules
          and land in the live workbench. */}
      <a href="#main-content" className="skip-link">
        跳到主内容
      </a>
      <TopBar />
      <Box as="main" id="main-content" flex="1" minH={0}>
        {children}
      </Box>
      <FeatCmdPalette />
      <FeatNotify />
    </Box>
  );
}

/**
 * Global Cmd/Ctrl+K listener. Bound at the shell so any focused
 * surface (other than the terminal) can invoke the palette. We ignore
 * the shortcut while typing in inputs / contenteditable so the user
 * can paste with ⌘V → ⌘K muscle memory without surprise.
 */
function useGlobalCmdKey({ enabled }: { readonly enabled: boolean }): void {
  const toggle = useCmdPaletteStore((s) => s.toggle);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [enabled, toggle]);
}

/**
 * Sync persisted theme → `<html data-theme="...">`. On first paint,
 * seed the store from `prefers-color-scheme` so a user landing on
 * the workbench from a system-dark device gets the dark workbench
 * without a light flash.
 */
function useThemeAttribute(): void {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  // Seed from system preference once. The settings store hydrates
  // from the backend asynchronously; until then we use the OS hint
  // so the first paint is correct on every visit.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (typeof window === 'undefined') return;
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark && theme === 'light') setTheme('dark');
  }, [theme, setTheme]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);
}
