'use client';

/**
 * Root client providers (theme + react-query). Mounted at the root
 * layout so every route gets a query client and theme tokens.
 *
 * The remote-sync boot (sectors / settings GETs + debounced PUTs)
 * intentionally does **not** live here — it moved to
 * `(app)/layout.tsx → RemoteSyncBoot` so 404 / future static pages
 * outside the workbench shell don't pay for hydrating data they will
 * never render.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { FeatHotkeyHint } from '../components/feat-hotkey-hint/feat-hotkey-hint.js';
import { getClientConfig } from './config/config-center-next-client-getter.js';
import { registerStoreExportGlobal } from './storage/export-stores.js';
import { ThemeProvider } from './theme/provider.js';
import { ConfirmHub } from './ui-cmd/confirm/confirm-hub.js';
import { UiCmdEngine } from './ui-cmd/engine/install.js';
import { installGlobalCells } from './ui-cmd/global-cells.js';
import { startWebVitals } from './web-vitals/store.js';

interface ProvidersProps {
  readonly children: ReactNode;
}

export function Providers({ children }: ProvidersProps): ReactNode {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: getClientConfig().ui.reactQuery.defaultStaleTimeMs,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  useEffect(() => {
    registerStoreExportGlobal();
    // Subscribe to web-vitals at app root so LCP/CLS listeners are
    // registered before the user's first interaction — see
    // `lib/web-vitals/store.ts` for the reasoning.
    startWebVitals();
    // Register the FE-only UI command set (module switching, view-mode
    // toggles, hint window). Idempotent — safe across Fast Refresh.
    installGlobalCells();
  }, []);
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
      <UiCmdEngine />
      <FeatHotkeyHint />
      <ConfirmHub />
    </ThemeProvider>
  );
}
