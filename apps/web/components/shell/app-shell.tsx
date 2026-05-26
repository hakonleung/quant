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
 * The terminal is the single instruction surface for the FE: a global
 * ⌘K / Ctrl+K shortcut switches `appMode` to `term` so any keyboard
 * user can drop into a command prompt from anywhere in the shell.
 * Inside the terminal we leave the shortcut to xterm so the user can
 * paste with ⌘V → ⌘K muscle memory.
 *
 * Lives at the layout boundary so children only mount when the mode
 * actually shows them. That keeps the workbench's TanStack-Query
 * subscriptions and zustand selectors from running while the user is
 * driving the terminal.
 */

import { Box } from '@chakra-ui/react';
import dynamic from 'next/dynamic';
import { useEffect, useRef, type ReactNode } from 'react';

import { useLayoutStore } from '../../lib/stores/layout.store.js';
import { useSettingsStore } from '../../lib/stores/settings.store.js';
import { FeatNotify } from '../feat-notify/feat-notify.js';

import { PageBackdrop } from './page-backdrop.js';
import { TopBar } from './top-bar.js';

// xterm + the entire `@quant/terminal` engine only run in `term` mode,
// which is opt-in (toggled from the topbar TERM chip or ⌘K). Code-split
// so a user staying on the workbench never downloads the ~70 KB chunk.
// `ssr: false` because xterm pokes the DOM at module init.
const FeatTermMain = dynamic(
  () => import('../feat-term-main/feat-term-main.js').then((m) => ({ default: m.FeatTermMain })),
  { ssr: false },
);

export interface SessionChipInfo {
  readonly displayName: string;
  readonly mode: 'oauth' | 'env' | 'im';
}

interface AppShellProps {
  readonly children: ReactNode;
  readonly session?: SessionChipInfo;
}

export function AppShell({ children, session }: AppShellProps): React.ReactElement {
  const mode = useLayoutStore((s) => s.appMode);
  // Global ⌘K / Ctrl+K drops the user into terminal mode anywhere
  // outside it. Inside `term`, xterm owns the key.
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
      {/* Page wallpaper — single render of the brand CrtBackdrop
          recipe pinned at z-index:-1 so every pane / topbar / dialog
          sees the same canvas underneath. Term mode skips this (its
          BigLogo CRT chrome owns its own bg). */}
      <PageBackdrop />
      {/* Visually-hidden until focused — the only Tab stop above the
          topbar so keyboard users skip the ASCII brand + sys capsules
          and land in the live workbench. */}
      <a href="#main-content" className="skip-link">
        跳到主内容
      </a>
      <TopBar session={session} />
      <Box as="main" id="main-content" flex="1" minH={0}>
        {children}
      </Box>
      <FeatNotify />
    </Box>
  );
}

/**
 * Global Cmd/Ctrl+K listener. Bound at the shell so any focused
 * surface outside `term` mode can drop into the terminal. The
 * `term` mode disables it so xterm keeps the shortcut for itself.
 *
 * The mode setter is read off the store inside the effect (rather than
 * via a `useLayoutStore((s) => s.setAppMode)` selector) so we avoid
 * destructuring a method off the state object — the linter's
 * unbound-method rule trips on that pattern.
 */
function useGlobalCmdKey({ enabled }: { readonly enabled: boolean }): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      useLayoutStore.getState().setAppMode('term');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [enabled]);
}

/**
 * Sync persisted theme → `<html data-theme="...">` + Chakra-required
 * `dark` / `light` class on every theme change.
 *
 * The first-paint seed (prefers-color-scheme → cached theme → light)
 * now lives in the inline boot script in `app/layout.tsx`, which runs
 * before any CSS evaluates. That eliminates the dark-mode flash on
 * refresh — the old `useEffect`-based seeding always ran AFTER the
 * first paint, so users on a system-dark device saw a brief light
 * frame before the store flip kicked in.
 *
 * This effect keeps the `<html>` chrome in lockstep with the store so
 * later theme switches (manual toggle, backend hydration via
 * `applyCfg`) propagate to the DOM even though `setTheme` already
 * syncs synchronously — defensive parity for any code path that
 * mutates `state.theme` via raw `setState`.
 */
function useThemeAttribute(): void {
  const theme = useSettingsStore((s) => s.theme);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.dataset['theme'] = theme;
    // Chakra v3's `_dark` conditional value uses the selector
    // `.dark &, .dark .chakra-theme:not(.light) &`, so the semantic
    // tokens only flip when the root carries a `dark` className. The
    // `[data-theme]` attribute is kept for native `color-scheme` and
    // any non-Chakra CSS that consumes it.
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme === 'light');
  }, [theme]);
}
