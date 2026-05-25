import type { ReactNode } from 'react';
import type { Viewport } from 'next';

import { Providers } from '../lib/providers.js';

import './globals.css';

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
  // The `<meta name="theme-color">` tag must inline a literal colour —
  // it is parsed before our CSS / JS run, so CSS vars (and therefore
  // `useTokenColor`) are not an option. Keep these two hex values in
  // sync with the workbench `bg` semantic token (light = `palette.light.bg`,
  // dark = `palette.term.bg` — TERM.MAIN is the dark-mode root surface).
  // See `apps/web/lib/theme/tokens.ts`.
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
        {/* A11y baseline + theme overrides live in `globals.css` (imported
            above). They used to be an inline `<style>` block here, but
            that conflicted with Chakra v3's emotion-injected
            `<style data-emotion>` siblings during hydration and produced
            React "Text content did not match server-rendered HTML"
            errors. Routing the same rules through Next's CSS pipeline
            emits a deterministic `<link rel="stylesheet">` instead. */}
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
