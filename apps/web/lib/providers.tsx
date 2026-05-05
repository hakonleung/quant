'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { useSectorsRemoteSync } from './stores/sectors.store.js';
import { useSysCfgRemoteSync } from './stores/settings.store.js';
import { registerStoreExportGlobal } from './storage/export-stores.js';
import { ThemeProvider } from './theme/provider.js';

interface ProvidersProps {
  readonly children: ReactNode;
}

function RemoteSyncBoot(): null {
  useSectorsRemoteSync();
  useSysCfgRemoteSync();
  return null;
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
      <QueryClientProvider client={client}>
        <RemoteSyncBoot />
        {children}
      </QueryClientProvider>
    </ThemeProvider>
  );
}
