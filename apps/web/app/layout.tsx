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
  // sync with `palette.light.bg` / `palette.dark.bg` from
  // `apps/web/lib/theme/tokens.ts` (Liquid Glass workbench canvas).
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F5F5F7' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0C10' },
  ],
};

/**
 * Inline boot script — runs BEFORE any CSS evaluates so the `<html>`
 * element carries the right `dark` / `light` class on the very first
 * paint. Without this, the workbench renders in light mode until the
 * settings store hydrates from the backend, producing a visible flash
 * for users on dark mode.
 *
 * Resolution order: localStorage cache (`qx-theme`, written by the
 * settings store as a side-effect of every `setTheme`) → OS
 * `prefers-color-scheme` → default light. Anything stored on the
 * backend overrides this once the store finishes hydrating; the boot
 * script only handles the pre-hydration window.
 */
const THEME_BOOT_SCRIPT = `
(function () {
  try {
    var t = localStorage.getItem('qx-theme');
    if (t !== 'dark' && t !== 'light') {
      t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    var r = document.documentElement;
    r.dataset.theme = t;
    r.classList.add(t);
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: RootLayoutProps): ReactNode {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Inter Variable as the cross-platform SF Pro fallback (loads
            instantly on Apple devices since they prefer system SF
            Pro). JetBrains Mono / Space Mono as cross-platform SF
            Mono fallback. Press Start 2P only for the BigLogo. */}
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
