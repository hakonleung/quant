import type { ReactNode } from 'react';

import { Providers } from '../lib/providers.js';

interface RootLayoutProps {
  readonly children: ReactNode;
}

export const metadata = {
  title: 'QUANT//OS',
  description: 'Local quant workbench — pro × geek',
};

export default function RootLayout({ children }: RootLayoutProps): ReactNode {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <style>{`@keyframes blink{50%{opacity:0}}`}</style>
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
