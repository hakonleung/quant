/**
 * Design tokens lifted from docs/design/05-pro-geek.html and the
 * unified-theme design (apps/web/lib/theme/THEME_DESIGN.md).
 *
 * Five sub-palettes coexist:
 *   - `light.*`     — workbench surface in light mode (amber on neutral)
 *   - `dark.*`      — workbench surface in dark mode (graphite + amber)
 *   - `term.*`      — cyberpunk terminal slot, dark variant (neon)
 *   - `termLight.*` — terminal slot, light variant (desaturated forest
 *                     on linen, see THEME_DESIGN.md §2)
 *   - `brand.*`     — logo / CRT chrome, one entry per mode (gradients,
 *                     glow strings, grid colour, scanline alpha)
 *
 * Token names are stable contract: components reference them via Chakra
 * semantic tokens (see `system.ts`), never raw hex.
 */

export const palette = {
  light: {
    bg: '#f4f5f7',
    panel: '#ffffff',
    panel2: '#fbfbfa',
    panel3: '#fafbfc',
    line: '#e3e5ea',
    hover: '#f5f7fb',
    ink: '#161a22',
    ink2: '#5a6371',
    ink3: '#8e96a3',
    amber: '#b87514',
    amberDark: '#a66610',
    amberBg: '#fff4dd',
    up: '#c9303f',
    down: '#127a55',
    blue: '#1e62c8',
    violet: '#6b4ce0',
    green: '#1f8a4f',
    greenBg: '#e8f6ee',
    badgeBg: '#eef0f4',
  },
  /**
   * Dark workbench palette — distinct from `term.*` which carries the
   * neon-CRT aesthetic. The dark workbench is meant to read as the
   * regular pro UI under low-light / night-shift conditions: neutral
   * graphite surfaces, the same amber accent (slightly brighter for
   * AAA contrast against panel), softer up / down hues so a sea of
   * red on the screening list doesn't strain the eye.
   */
  dark: {
    bg: '#0d1014',
    panel: '#11151b',
    panel2: '#161b22',
    panel3: '#1a2129',
    line: '#1f2731',
    hover: '#1c232c',
    ink: '#e6ebf2',
    ink2: '#a8b2c0',
    ink3: '#6f7888',
    amber: '#e29e3a',
    amberDark: '#c9852a',
    amberBg: '#3a2810',
    up: '#ff5566',
    down: '#3fbf86',
    blue: '#5aa0ff',
    violet: '#9d80ff',
    green: '#3fbf86',
    greenBg: '#0f2a1d',
    badgeBg: '#1a2129',
  },
  term: {
    bg: '#06080a',
    panel: '#0a0e10',
    panel2: '#0f1417',
    bgElev: '#131b20',
    line: '#1a2227',
    ink: '#cfead8',
    ink2: '#7da896',
    ink3: '#4d6c61',
    green: '#5eff9c',
    greenDark: '#1f8a4f',
    cyan: '#5cf2ff',
    magenta: '#ff5cd1',
    amber: '#ffc14d',
    red: '#ff4d6d',
    inputBg: '#06090a',
  },
  /**
   * Light variant of the terminal slot — keeps the "different zone"
   * feel against the workbench but trades cyberpunk neon for a
   * desaturated forest-on-linen palette. Hue families match the dark
   * neon so the user still reads "green prompt" / "amber warning"
   * semantically. See THEME_DESIGN.md §2 for contrast rationale.
   */
  termLight: {
    bg: '#f0f2f4',
    panel: '#e8ebee',
    panel2: '#dde1e6',
    bgElev: '#d4d9df',
    line: '#c5cad2',
    ink: '#1a2030',
    ink2: '#3a4a5a',
    ink3: '#6a7a8a',
    green: '#1a6b42',
    greenDark: '#135232',
    cyan: '#0068a8',
    magenta: '#8b1a6a',
    amber: '#b05500',
    red: '#b82231',
    inputBg: '#e4e8ec',
  },
  /**
   * Brand cells for the logo / CRT chrome. The logoBg / logoGlow are
   * pre-built CSS strings (radial-gradient / text-shadow) rather than
   * single hex so the boundary layer can drop them straight into
   * `style={{ background, textShadow }}` without re-assembling. Both
   * light and dark variants keep a forest-green CRT feel — the
   * BigLogo is meant to stay "still a terminal" even in light mode.
   */
  brand: {
    light: {
      logoBg:
        'radial-gradient(ellipse at center, #e8ede8 0%, #d8ddd8 65%, #c8cdc8 100%)',
      logoColor: '#2a4a30',
      logoGlow:
        'rgba(42,74,48,0.4) 0px 0px 4px, rgba(42,74,48,0.2) 0px 0px 12px',
      gridColor: 'rgb(80,100,80)',
      scanlineAlpha: 'rgba(0,0,0,0.10)',
      // Frosted-glass tints layered on top of the CRT background so the
      // dashboard / tips-bar reads as "elevated above the screen". In
      // light mode the underlying CRT is greenish-grey; the panelAlpha
      // is a near-white wash so text snaps back to dark-ink legibility
      // without losing the CRT vignette behind it. termGlowBorder is a
      // very faint translucent forest-green for accent rules.
      panelAlpha: 'rgba(232,237,232,0.78)',
      panelAlphaStrong: 'rgba(232,237,232,0.92)',
      tipsBarBg: 'rgba(228,232,228,0.86)',
      termGlowBorder: 'rgba(42,74,48,0.18)',
      termFocusRing: 'rgba(42,74,48,0.35)',
      phosphorDot: 'rgba(42,74,48,0.05)',
      vignette:
        'rgba(180,200,180,0.55) 0px 0px 160px inset, rgba(42,74,48,0.10) 0px 0px 60px inset',
    },
    dark: {
      logoBg:
        'radial-gradient(ellipse at center, #08120c 0%, #04060a 65%, #020406 100%)',
      logoColor: '#d4ffe2',
      logoGlow:
        'rgba(155,242,182,0.8) 0px 0px 4px, rgba(155,242,182,0.4) 0px 0px 12px, rgba(155,242,182,0.2) 0px 0px 28px',
      gridColor: 'rgb(26,58,38)',
      scanlineAlpha: 'rgba(0,0,0,0.32)',
      panelAlpha: 'rgba(10,14,16,0.72)',
      panelAlphaStrong: 'rgba(10,14,16,0.92)',
      tipsBarBg: 'rgba(6,8,10,0.78)',
      termGlowBorder: 'rgba(94,255,156,0.12)',
      termFocusRing: 'rgba(155,242,182,0.4)',
      phosphorDot: 'rgba(155,242,182,0.06)',
      vignette:
        'rgba(0,0,0,0.92) 0px 0px 220px inset, rgba(0,80,40,0.3) 0px 0px 90px inset',
    },
  },
} as const;

export const fonts = {
  sans: '-apple-system, "SF Pro Text", Inter, system-ui, sans-serif',
  mono: '"Space Mono", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  /**
   * Geek/cyberpunk-style terminal font. Falls back through the same chain as
   * `mono` if Monaspace isn't loaded (offline / CDN failure).
   */
  geek: '"Monaspace Neon", "Monaspace Krypton", "Monaspace Argon", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  /** Bitmap pixel font used by the TERM.MAIN big logo. */
  pixel: '"Press Start 2P", "Space Mono", "JetBrains Mono", "SF Mono", ui-monospace, monospace',
} as const;
