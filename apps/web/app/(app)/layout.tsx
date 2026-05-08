import type { ReactNode } from 'react';

import { AppShell } from '../../components/shell/app-shell.js';

interface AppLayoutProps {
  readonly children: ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps): ReactNode {
  return <AppShell>{children}</AppShell>;
}
