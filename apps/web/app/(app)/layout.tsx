import { redirect } from 'next/navigation.js';
import type { ReactNode } from 'react';

import { AppShell, type SessionChipInfo } from '../../components/shell/app-shell.js';
import { getAuthMode } from '../../lib/auth/config.js';
import { getSession } from '../../lib/auth/session.js';
import { RemoteSyncBoot } from '../../lib/remote-sync-boot.js';

interface AppLayoutProps {
  readonly children: ReactNode;
}

export default async function AppLayout({ children }: AppLayoutProps): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) redirect('/login');
  const chip: SessionChipInfo = {
    displayName: session.user.name,
    mode: getAuthMode() === 'oauth' ? 'oauth' : 'env',
  };
  return (
    <>
      <RemoteSyncBoot />
      <AppShell session={chip}>{children}</AppShell>
    </>
  );
}
