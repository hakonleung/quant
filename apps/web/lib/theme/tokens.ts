/**
 * Design tokens for the unified theme system. See
 * `apps/web/lib/theme/THEME_DESIGN.md` for the spec.
 *
 * Design language (task #16 — Apple Liquid Glass × 中国传统色魂):
 *
 *   - **Liquid Glass surface system.** The workbench rests on a pure,
 *     near-monochrome canvas (Apple system gray family) and floats
 *     translucent glass layers on top — `panel.glass` for cards
 *     embedded in the canvas, `panel.glassStrong` for modal/popover
 *     surfaces that need stronger readability. Borders become
 *     hair-thin (≤ 1px) and tinted with the canvas inverse so they
 *     read as "edge of the glass", not as a heavy frame.
 *
 *   - **Chinese-classical accent retained.** The hue inventory still
 *     speaks the 中国传统色 vocabulary that anchors this workbench
 *     culturally: 朱砂 (cinnabar) is the seal-stamp accent, 朱红 /
 *     石绿 are the up/down candles (CN convention), 黛紫 / 石青 stay
 *     as secondary accents. Saturations are pulled down slightly so
 *     they sit comfortably on the new clean canvas without screaming.
 *
 *   - **Term slot becomes a frosted-glass terminal.** The geek monospace
 *     foreground stays, but the container is a translucent dark glass
 *     (or near-white frosted glass in light mode). The retro CRT
 *     scanline / phosphor grid is preserved but its alpha is dialled
 *     down so it reads as "subtle texture on glass" rather than
 *     "shouting CRT".
 *
 *   - **Type & radius scales.** Apple-style type scale (12 / 13 / 15 /
 *     17 / 22 / 28) is exposed via `tokens.fontSizes`; radius scale
 *     (4 / 8 / 12 / 16 / 22) via `tokens.radii`. See system.ts.
 */

export const palette = {
  /**
   * Light = "瓷白宣纸" — pure white porcelain canvas with a hint of
   * warmth. The base surfaces are pulled from Apple's system gray
   * family; accents stay in the 中国传统色 vocabulary so the workbench
   * keeps its cultural fingerprint.
   */
  light: {
    bg: '#D5D8E0', // canvas — pulled darker than systemGray6 (#F5F5F7) so
                  // panels and glass surfaces above it have visible contrast;
                  // pairs with the ambient gradient (see system.ts → body)
    panel: '#FFFFFF', // solid white card — pane container handles glass via backdrop-filter
    panel3: '#F7F7F9', // subtle elevation (sticky chrome) — opaque against pane container
    line: 'rgba(60,60,67,0.14)', // Apple separator (slightly stronger for contrast)
    hover: 'rgba(60,60,67,0.05)', // Apple list-row hover
    ink: '#1D1D1F', // Apple label primary — never pure black
    ink2: '#5A5A5F', // Apple label secondary — bumped from #6E6E73 for AA on glass.panel
    ink3: '#737378', // Apple label tertiary — bumped from #86868B (4.55:1 on white, ≥AA)
    /**
     * `accent` = Apple monochrome label primary (#1D1D1F). Apple's
     * default "graphite" appearance uses near-black accents on white
     * surfaces — no purple, no indigo, just clean monochrome. CN
     * cultural fingerprint stays only in `up` / `down` (financial).
     */
    amber: '#1D1D1F', // Apple label primary — monochrome accent
    amberBg: 'rgba(29,29,31,0.08)', // soft graphite wash
    up: '#C8392F', // 朱红 — financial rising red (CN convention)
    down: '#1F8A5C', // 石绿 — deepened from #52A983 for AA on white (~4.6:1)
    blue: '#0066CC', // Apple-tinted link blue — deepened from #0A84FF for AA on white (~4.78:1)
    violet: '#6B4FA5', // 黛紫 — slightly deepened for AA on white
  },
  /**
   * Dark = "墨玉夜空" — deep neutral ink-black canvas with vermilion
   * seal still glowing under moonlight. Built on Apple's dark
   * elevated-surface system so glass layers read clearly against it.
   */
  dark: {
    bg: '#040508', // canvas — even deeper so glass layers have room to glow
    panel: '#16171D', // solid dark panel — opaque, glass at container level
    panel3: '#1F2027', // elevated section chrome (opaque)
    line: 'rgba(255,255,255,0.10)', // Apple dark separator (slightly stronger)
    hover: 'rgba(255,255,255,0.05)', // Apple dark list-row hover
    ink: '#F5F5F7', // Apple dark label primary
    ink2: '#B8B8BD', // Apple dark label secondary — bumped from #A1A1A6 for AA on glass
    ink3: '#9A9AA0', // Apple dark label tertiary — bumped from #6E6E73 (4.62:1 on panel)
    amber: '#F5F5F7', // Apple dark label primary — monochrome accent
    amberBg: 'rgba(245,245,247,0.10)',
    up: '#FF6B5E', // 朱红 — financial rising red (CN convention)
    down: '#5FD3A3', // 石绿 — bright jade against ink
    blue: '#5AC8FA', // Apple system teal-blue — better AA on dark panels (~7.5:1)
    violet: '#B197D6', // 黛紫 — softened for dark
  },
  /**
   * Term slot — Apple-style frosted terminal. Background is translucent
   * dark glass; foreground keeps monospace geek tone. Used by every
   * "terminal-feel" panel embedded in the workbench (TipsBar,
   * dashboards, HoverInfoBox, column-manager, hotkey hint).
   */
  term: {
    bg: 'rgba(21,22,28,0.72)', // dark glass surface (needs backdrop-filter)
    panel: 'rgba(15,16,20,0.78)', // PaneSection header glass
    panel2: 'rgba(15,16,20,0.78)',
    bgElev: 'rgba(28,29,36,0.82)', // dashboard cells / hotkey hint
    line: 'rgba(255,255,255,0.10)', // glass edge
    ink: '#F5F5F7',
    ink2: '#B8B8BD', // mirror dark.ink2 (AA on dark glass)
    ink3: '#9A9AA0', // mirror dark.ink3 (AA on dark panel)
    green: '#5FD3A3', // 石绿 — prompt indicator
    greenDark: '#3A9D74',
    cyan: '#5AC8FA', // Apple system teal — info glyph
    magenta: '#BF7BB6',
    amber: '#FF9F0A', // Apple system orange — warning glyph
    red: '#FF6B5E', // 朱砂 red — error glyph
    inputBg: 'rgba(11,12,16,0.85)',
  },
  /**
   * Light variant of the term slot — frosted white glass. Same
   * monospace geek foreground, but on translucent porcelain instead
   * of dark glass. Used inside light-mode workbench.
   */
  termLight: {
    bg: 'rgba(255,255,255,0.72)',
    panel: 'rgba(250,250,251,0.80)',
    panel2: 'rgba(250,250,251,0.80)',
    bgElev: 'rgba(245,245,247,0.86)',
    line: 'rgba(60,60,67,0.14)',
    ink: '#1D1D1F',
    ink2: '#5A5A5F', // mirror light.ink2 (AA on glass)
    ink3: '#737378', // mirror light.ink3 (AA on white)
    green: '#1F8A5C', // mirror light.down (AA on white)
    greenDark: '#176945',
    cyan: '#0066CC', // mirror light.blue (Apple-tinted link, AA on white)
    magenta: '#6B4FA5', // mirror light.violet
    amber: '#C2410C', // burnt sienna — readable warning on white glass
    red: '#B83A2E', // mirror light.amber/up (AA on white)
    inputBg: 'rgba(255,255,255,0.92)',
  },
  /**
   * xterm.js 16-slot — Apple-style frosted terminal. Light uses a
   * near-white frosted background with deep-ink foreground; dark
   * uses dark glass with high-contrast off-white. ANSI accents keep
   * the 中国传统色 anchor (朱砂 red) but otherwise lean on Apple's
   * system color set for familiarity.
   */
  xterm: {
    light: {
      bg: '#FBFBFD', // near-white porcelain (xterm cannot blur, so use solid)
      ink: '#1D1D1F',
      cursor: '#B83A2E', // 朱砂 — AA on white
      cursorAccent: '#FBFBFD',
      selection: 'rgba(0,102,204,0.18)', // Apple selection blue (matches new link)
      black: '#1D1D1F',
      red: '#B83A2E', // 朱砂 — AA on white
      green: '#1F8A5C', // 石绿
      yellow: '#C2410C', // burnt sienna for AA on white
      blue: '#0066CC', // Apple-tinted link blue (AA on white)
      magenta: '#6B4FA5', // 黛紫 — AA on white
      cyan: '#0066CC',
      white: '#3A3A3C',
      brightBlack: '#737378',
      brightRed: '#D24C44',
      brightGreen: '#3D9D6F',
      brightYellow: '#D85410',
      brightBlue: '#0A84FF',
      brightMagenta: '#7B5BB6',
      brightCyan: '#0A84FF',
      brightWhite: '#1D1D1F',
    },
    dark: {
      bg: '#0F1014', // dark glass equivalent (solid for xterm)
      ink: '#F5F5F7',
      cursor: '#FF6B5E', // 朱砂 glow
      cursorAccent: '#0F1014',
      selection: 'rgba(10,132,255,0.32)',
      black: '#1C1D24',
      red: '#FF6B5E',
      green: '#5FD3A3',
      yellow: '#FF9F0A',
      blue: '#5AC8FA',
      magenta: '#B197D6',
      cyan: '#5AC8FA',
      white: '#F5F5F7',
      brightBlack: '#6E6E73',
      brightRed: '#FF8A7F',
      brightGreen: '#8FE3B8',
      brightYellow: '#FFB84D',
      brightBlue: '#7FD3FF',
      brightMagenta: '#CDB3E0',
      brightCyan: '#7FD3FF',
      brightWhite: '#FFFFFF',
    },
  },
  /**
   * Brand cells. Liquid Glass refactor: CRT grid + scanline alpha
   * dropped near-zero so the workbench reads as "glass with subtle
   * texture" instead of "shouting CRT". Vignette becomes a soft
   * ambient halo. logoColor stays 朱砂 — the cultural seal.
   */
  brand: {
    light: {
      logoBg:
        'radial-gradient(ellipse at center, rgba(255,255,255,0.95) 0%, rgba(245,245,247,0.88) 60%, rgba(235,235,238,0.82) 100%)',
      logoColor: '#1D1D1F', // monochrome brand mark — Apple graphite
      logoGlow: '0 0 1px rgba(29,29,31,0.35), 0 0 12px rgba(29,29,31,0.12)',
      gridColor: 'rgba(29,29,31,0.10)', // workbench-visible while still subtle in Brand at logo size
      scanlineAlpha: 'rgba(29,29,31,0.06)', // multiply blend makes 6% read as clear scanline
      panelAlpha: 'rgba(255,255,255,0.72)', // glass card alpha
      panelAlphaStrong: 'rgba(255,255,255,0.86)',
      tipsBarBg: 'rgba(250,250,251,0.78)',
      termGlowBorder: 'rgba(184,58,46,0.16)',
      termFocusRing: 'rgba(0,102,204,0.42)', // Apple focus blue (mirror new light.blue)
      phosphorDot: 'rgba(184,58,46,0.03)',
      vignette:
        'rgba(29,29,31,0.04) 0 0 80px inset, rgba(31,138,92,0.03) 0 0 40px inset',
    },
    dark: {
      logoBg:
        'radial-gradient(ellipse at center, rgba(28,29,36,0.92) 0%, rgba(15,16,20,0.88) 60%, rgba(8,9,13,0.82) 100%)',
      logoColor: '#F5F5F7', // monochrome brand mark — clean white
      logoGlow:
        '0 0 1px rgba(245,245,247,0.55), 0 0 14px rgba(245,245,247,0.22), 0 0 32px rgba(245,245,247,0.10)',
      gridColor: 'rgba(255,255,255,0.08)', // dark — bump for workbench-scale visibility
      scanlineAlpha: 'rgba(0,0,0,0.40)', // multiply needs higher alpha on dark base
      panelAlpha: 'rgba(21,22,28,0.72)', // dark glass alpha
      panelAlphaStrong: 'rgba(21,22,28,0.88)',
      tipsBarBg: 'rgba(15,16,20,0.78)',
      termGlowBorder: 'rgba(245,245,247,0.10)',
      termFocusRing: 'rgba(10,132,255,0.45)',
      phosphorDot: 'rgba(255,255,255,0.025)',
      vignette:
        'rgba(0,0,0,0.60) 0 0 200px inset, rgba(245,245,247,0.06) 0 0 60px inset',
    },
  },
  /**
   * Glass overlay cells — semi-transparent surfaces meant to be paired
   * with `backdrop-filter: blur(...)`. Used by dialogs, popovers,
   * floating hint windows, FeatView header strips. Two strengths
   * matching the brand panelAlpha twin (kept separate so non-Term
   * callers can dial without touching the brand scrolls).
   */
  glass: {
    light: {
      panel: 'rgba(255,255,255,0.28)', // VERY translucent — wallpaper grid clearly shows through
      panelStrong: 'rgba(255,255,255,0.70)', // dialog / strong popover
      panelSoft: 'rgba(255,255,255,0.28)', // softest (chrome strip)
      line: 'rgba(60,60,67,0.10)', // glass edge
      lineStrong: 'rgba(60,60,67,0.16)', // dialog edge
      highlight: 'rgba(255,255,255,0.6)', // top inset highlight
      // Pre-baked composite shadow for floating glass surfaces.
      // Apple-style soft layered shadow.
      shadow:
        '0 8px 32px rgba(15,17,22,0.10), 0 2px 8px rgba(15,17,22,0.05), inset 0 1px 0 rgba(255,255,255,0.6)',
      shadowStrong:
        '0 20px 60px rgba(15,17,22,0.18), 0 4px 16px rgba(15,17,22,0.08), inset 0 1px 0 rgba(255,255,255,0.7)',
    },
    dark: {
      panel: 'rgba(21,22,28,0.28)',
      panelStrong: 'rgba(21,22,28,0.70)',
      panelSoft: 'rgba(21,22,28,0.28)',
      line: 'rgba(255,255,255,0.08)',
      lineStrong: 'rgba(255,255,255,0.14)',
      highlight: 'rgba(255,255,255,0.06)',
      shadow:
        '0 8px 32px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06)',
      shadowStrong:
        '0 20px 60px rgba(0,0,0,0.60), 0 4px 16px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)',
    },
  },
} as const;

export const fonts = {
  /**
   * Apple system font stack. SF Pro Text/Display are the default on
   * Apple platforms; everywhere else we fall through to Inter (loaded
   * via Google Fonts in `app/layout.tsx`) → system-ui.
   */
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Inter Variable", Inter, system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  /**
   * Apple system mono first, then JetBrains Mono as fallback. Used by
   * all `.num` / `.mono` cells and the xterm fallback chain.
   */
  mono: '"SF Mono", "JetBrains Mono", "Space Mono", ui-monospace, Menlo, Consolas, monospace',
  /**
   * Geek/cyberpunk-style terminal font. Keeps Monaspace Neon for the
   * actual xterm pane — the "real terminal" gets to keep its identity.
   */
  geek: '"Monaspace Neon", "Monaspace Krypton", "Monaspace Argon", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  /** Bitmap pixel font used by the TERM.MAIN big logo. */
  pixel: '"Press Start 2P", "Space Mono", "JetBrains Mono", "SF Mono", ui-monospace, monospace',
} as const;

/**
 * Apple-style type scale. Workbench body sits at `body` (13px) so the
 * dense data grid stays compact; form fields and section headings
 * climb to `md` / `lg` for finger-friendly readability. Hero copy in
 * the login / dashboard zone uses `xl` / `2xl`.
 */
export const fontSizes = {
  xs: '11px', // captions, axis ticks, meta labels
  sm: '12px', // small labels, table sub-text
  body: '13px', // body, data tables (workbench default)
  md: '15px', // form inputs, secondary headings (Apple body)
  lg: '17px', // section headings (Apple headline)
  xl: '22px', // page titles
  '2xl': '28px', // hero / login title
} as const;

/**
 * Apple-style radius scale. Workbench keeps a square-ish chrome
 * (FeatView panes stay 0 to preserve the geek angle markers), but
 * dialogs, popovers, cards, and inputs adopt the soft-corner family.
 */
export const radii = {
  none: '0',
  xs: '4px', // chips, small badges, inputs
  sm: '8px', // buttons, inputs, list rows
  md: '12px', // dropdowns, secondary cards
  lg: '16px', // dialogs, popovers, primary cards
  xl: '22px', // hero cards, oversized sheets
  pill: '9999px',
} as const;
