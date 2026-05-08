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
        {/* A11y baseline — lives outside Chakra's `globalCss` so we
            can use top-level `@media` rules and the `:focus-visible`
            pseudo without fighting v3's strict style-object type.
              · `.blink` strobe + global animation reset for users
                who set `prefers-reduced-motion: reduce`
              · A 1-px accent outline on every `:focus-visible` host
                so keyboard users always see where focus landed —
                Chrome's default ring is suppressed by Chakra
                normalize otherwise
              · `.skip-link` lets keyboard users jump past the topbar
                / chrome straight into the workbench main region. The
                link is visually hidden until focused. */}
        <style>{`@keyframes blink{50%{opacity:0}}@media (prefers-reduced-motion: reduce){.blink{animation:none!important}*,*::before,*::after{animation-duration:0.001ms!important;animation-iteration-count:1!important;transition-duration:0.001ms!important;scroll-behavior:auto!important}}:focus-visible{outline:1px solid var(--chakra-colors-accent,#b87514);outline-offset:1px}.skip-link{position:fixed;top:8px;left:8px;z-index:2000;padding:6px 12px;background:var(--chakra-colors-panel,#fff);color:var(--chakra-colors-accent,#b87514);font-family:'Space Mono',monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;border:1px solid currentColor;transform:translateY(-200%);transition:transform 120ms ease}.skip-link:focus{transform:translateY(0)}[data-theme="dark"]{--chakra-colors-bg:#0d1014;--chakra-colors-panel:#11151b;--chakra-colors-panel2:#161b22;--chakra-colors-panel3:#1a2129;--chakra-colors-line:#1f2731;--chakra-colors-line2:#2a3340;--chakra-colors-hover:#1c232c;--chakra-colors-ink:#e6ebf2;--chakra-colors-ink2:#a8b2c0;--chakra-colors-ink3:#6f7888;--chakra-colors-accent:#e29e3a;--chakra-colors-accentDark:#c9852a;--chakra-colors-accentBg:#3a2810;--chakra-colors-up:#ff5566;--chakra-colors-down:#3fbf86;--chakra-colors-link:#5aa0ff;--chakra-colors-violet:#9d80ff;--chakra-colors-prompt:#3fbf86;--chakra-colors-promptBg:#0f2a1d;--chakra-colors-badgeBg:#1a2129;color-scheme:dark}[data-theme="light"]{color-scheme:light}@media (max-width:767px){html,body{font-size:14px!important}}`}</style>
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
