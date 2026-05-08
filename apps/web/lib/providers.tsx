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

import { registerStoreExportGlobal } from './storage/export-stores.js';
import { ThemeProvider } from './theme/provider.js';

interface ProvidersProps {
  readonly children: ReactNode;
}

export function Providers({ children }: ProvidersProps): ReactNode {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
      }),
  );
  useEffect(() => {
    registerStoreExportGlobal();
  }, []);
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}
