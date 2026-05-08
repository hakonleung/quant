import type { ReactNode } from 'react';
import type { Viewport } from 'next';

import { Providers } from '../lib/providers.js';

interface RootLayoutProps {
  readonly children: ReactNode;
}

export const metadata = {
  title: 'qX//OS',
  description: 'Local quant workbench — pro × geek',
};

/**
 * Next.js viewport API — emits the right `<meta name="viewport">` and
 * `theme-color` tags. `viewportFit: 'cover'` lets the workbench paint
 * under the iOS notch so its safe-area padding (see AppShell) reads as
 * intentional chrome rather than a black band.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f5f7' },
    { media: '(prefers-color-scheme: dark)', color: '#06080a' },
  ],
};

export default function RootLayout({ children }: RootLayoutProps): ReactNode {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=Space+Mono:wght@400;700&family=Press+Start+2P&display=swap"
          rel="stylesheet"
        />
        {/* Monaspace Neon — geek-style font for the TERM.MAIN xterm. */}
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link
          href="https://cdn.jsdelivr.net/npm/@fontsource/monaspace-neon@5.0.16/index.css"
          rel="stylesheet"
        />
        {/* Reduced-motion override lives outside Chakra's globalCss so
            it can use a top-level `@media` block — Chakra v3's
            `globalCss` type rejects nested at-rules. The strobe class
            and global animation/transition resets ensure assistive-
            tech users get the same UI without the kinetic effects. */}
        <style>{`@keyframes blink{50%{opacity:0}}@media (prefers-reduced-motion: reduce){.blink{animation:none!important}*,*::before,*::after{animation-duration:0.001ms!important;animation-iteration-count:1!important;transition-duration:0.001ms!important;scroll-behavior:auto!important}}`}</style>
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
