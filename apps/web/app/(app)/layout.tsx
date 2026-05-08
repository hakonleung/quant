import type { ReactNode } from 'react';

import { AppShell } from '../../components/shell/app-shell.js';
import { RemoteSyncBoot } from '../../lib/remote-sync-boot.js';

interface AppLayoutProps {
  readonly children: ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps): ReactNode {
  return (
    <>
      <RemoteSyncBoot />
      <AppShell>{children}</AppShell>
    </>
  );
}
