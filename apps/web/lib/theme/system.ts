/**
 * Chakra UI v3 system: design tokens + semantic tokens for the
 * pro-geek workbench. Everything else in the app must consume tokens
 * from here, never raw hex (CLAUDE.md §1.2).
 *
 * Theme switching is driven by Chakra's `_dark` conditional value, which
 * fires when `color-scheme: dark` is on the element. `globals.css`
 * just maps `[data-theme='dark'] → color-scheme: dark`; every colour
 * token below auto-flips. No hand-rolled CSS-var override block.
 *
 * Semantic-token set was trimmed in task #6 — see THEME_DESIGN.md
 * "瘦身记录". Aliases were collapsed onto their canonical token, near-
 * duplicate accent/panel/shadow variants merged.
 */

import { createSystem, defaultConfig, defineConfig, defineRecipe } from '@chakra-ui/react';

import { fonts, palette } from './tokens.js';

const { light, dark, term, termLight, brand } = palette;

/**
 * `monoButton` — a single-glyph mono icon button used inside pane chrome
 * (FeatView controls, action slots). The visual glyph is small (11px)
 * but the click hot-zone (the rendered button box) is larger so it is
 * comfortable to hit on touch / trackpad. Hover triggers a smooth
 * color transition on the glyph itself.
 */
const monoButtonRecipe = defineRecipe({
  className: 'mono-btn',
  base: {
    display: 'grid',
    placeItems: 'center',
    bg: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'mono',
    lineHeight: '1',
    color: 'term.ink3',
    transition: 'transform 140ms ease, color 140ms ease',
    transformOrigin: 'center',
    minW: 0,
    p: 0,
    _hover: { bg: 'transparent', transform: 'scale(1.25)', color: 'term.green' },
    _active: { transform: 'scale(1.1)' },
    _disabled: {
      opacity: 0.4,
      cursor: 'not-allowed',
      _hover: { bg: 'transparent', transform: 'none', color: 'term.ink3' },
    },
    _focusVisible: { outline: '1px solid', outlineColor: 'term.green', outlineOffset: '1px' },
    // Touch devices get a 36-square hit zone (centred glyph stays the
    // same visual size). Apple HIG / Material both call for ≥ 36px;
    // we don't push to 44 so existing pane chrome doesn't reflow on
    // tablets that already have their own dense grids. Hover is
    // suppressed since `(hover: hover)` is false here — the scale
    // animation looked janky as a tap-feedback on phones.
    '@media (pointer: coarse)': {
      minW: '36px',
      minH: '36px',
      _hover: { bg: 'transparent', transform: 'none' },
      _active: { bg: 'panel3', transform: 'none' },
    },
  },
  variants: {
    size: {
      sm: { w: '18px', h: '18px', fontSize: '11px' },
      md: { w: '22px', h: '22px', fontSize: '13px' },
    },
  },
  defaultVariants: { size: 'sm' },
});

const config = defineConfig({
  globalCss: {
    'html, body': {
      margin: 0,
      bg: '{colors.bg}',
      color: '{colors.ink}',
      fontFamily: '{fonts.body}',
      // 13 px on the workbench is the legibility sweet spot — the
      // dense table chrome stays compact, but body prose / form
      // labels regain enough x-height to read for hours. Mobile gets
      // a 1-px nudge in `app/layout.tsx` so the touch reading
      // distance compensates for thumb-eye geometry.
      fontSize: '13px',
      lineHeight: '1.5',
    },
    '*': { boxSizing: 'border-box' },
    '.num, .mono': {
      fontFamily: '{fonts.mono}',
      fontFeatureSettings: '"tnum" 1',
      fontVariantNumeric: 'tabular-nums',
    },
    '.blink': { animation: 'blink 1s steps(2) infinite' },
  },
  theme: {
    tokens: {
      fonts: {
        body: { value: fonts.sans },
        heading: { value: fonts.sans },
        mono: { value: fonts.mono },
      },
      colors: {
        // ---- light workbench raw palette (kept for legacy semantic
        // references and any business component that still imports
        // `palette.light.*`)
        light: {
          bg: { value: light.bg },
          panel: { value: light.panel },
          panel3: { value: light.panel3 },
          line: { value: light.line },
          hover: { value: light.hover },
          ink: { value: light.ink },
          ink2: { value: light.ink2 },
          ink3: { value: light.ink3 },
          amber: { value: light.amber },
          amberBg: { value: light.amberBg },
          up: { value: light.up },
          down: { value: light.down },
          blue: { value: light.blue },
          violet: { value: light.violet },
        },
        // ---- cyber terminal palette (dark)
        term: {
          bg: { value: term.bg },
          panel: { value: term.panel },
          bgElev: { value: term.bgElev },
          line: { value: term.line },
          ink: { value: term.ink },
          ink2: { value: term.ink2 },
          ink3: { value: term.ink3 },
          green: { value: term.green },
        },
      },
    },
    recipes: {
      monoButton: monoButtonRecipe,
    },
    semanticTokens: {
      colors: {
        // ---- workbench surface (auto-flips on color-scheme: dark)
        bg: { value: { base: light.bg, _dark: dark.bg } },
        panel: { value: { base: light.panel, _dark: dark.panel } },
        panel3: { value: { base: light.panel3, _dark: dark.panel3 } },
        line: { value: { base: light.line, _dark: dark.line } },
        hover: { value: { base: light.hover, _dark: dark.hover } },
        ink: { value: { base: light.ink, _dark: dark.ink } },
        ink2: { value: { base: light.ink2, _dark: dark.ink2 } },
        ink3: { value: { base: light.ink3, _dark: dark.ink3 } },
        accent: { value: { base: light.amber, _dark: dark.amber } },
        accentBg: { value: { base: light.amberBg, _dark: dark.amberBg } },
        // `up` doubles as `danger`: stocks-up red and form-error red
        // are intentionally the same hue. Login/form callers reach for
        // `up` directly now that the alias is gone.
        up: { value: { base: light.up, _dark: dark.up } },
        // `down` doubles as the CLI prompt-success green — same hue
        // family, no need for a separate `prompt` token.
        down: { value: { base: light.down, _dark: dark.down } },
        link: { value: { base: light.blue, _dark: dark.blue } },
        violet: { value: { base: light.violet, _dark: dark.violet } },

        // Backdrop scrim for modals / popovers. Both modes use a
        // translucent dark wash, but the light variant is intentionally
        // lighter — a 55% black on a near-white page creates a harsh
        // funnel that fights the "frosted card on top" affordance.
        overlay: { value: { base: 'rgba(20,24,32,0.32)', _dark: 'rgba(15,17,22,0.55)' } },

        // ---- term slot (light variant ↔ dark cyberpunk)
        // Trimmed to the cells consumers actually reference; xterm-theme
        // and other 16-slot ANSI palettes pull straight from the raw
        // `palette.term` / `palette.termLight` constants instead.
        term: {
          bg: { value: { base: termLight.bg, _dark: term.bg } },
          panel: { value: { base: termLight.panel, _dark: term.panel } },
          bgElev: { value: { base: termLight.bgElev, _dark: term.bgElev } },
          line: { value: { base: termLight.line, _dark: term.line } },
          ink: { value: { base: termLight.ink, _dark: term.ink } },
          ink2: { value: { base: termLight.ink2, _dark: term.ink2 } },
          ink3: { value: { base: termLight.ink3, _dark: term.ink3 } },
          green: { value: { base: termLight.green, _dark: term.green } },
        },

        // ---- distribution / KDE viz
        // Only `mean` and `median` keep dedicated hues — magenta + cyan
        // are visually distinct from the workbench palette and from
        // each other, and the two stat lines coexist on screen.
        // Removed in task #8 — callers now use these workbench tokens
        // directly (see THEME_DESIGN.md 瘦身记录):
        //   chart.ma.fast  → link        chart.ma.short → accent
        //   chart.ma.mid   → violet      chart.ma.slow  → down
        //   chart.focus.range → link (SVG fillOpacity={0.06})
        //   dist.stat.zero    → ink3
        //   dist.stat.baseline → accent
        //   dist.bar.fill     → ink2 (SVG fillOpacity={0.35})
        dist: {
          stat: {
            mean: { value: { base: '#c0147a', _dark: '#ff3ea5' } },
            median: { value: { base: '#007f8b', _dark: '#00e5ff' } },
          },
        },

        // ---- brand / logo CRT chrome
        brand: {
          logoBg: { value: { base: brand.light.logoBg, _dark: brand.dark.logoBg } },
          logoColor: { value: { base: brand.light.logoColor, _dark: brand.dark.logoColor } },
          logoGlow: { value: { base: brand.light.logoGlow, _dark: brand.dark.logoGlow } },
          gridColor: { value: { base: brand.light.gridColor, _dark: brand.dark.gridColor } },
          scanlineAlpha: {
            value: { base: brand.light.scanlineAlpha, _dark: brand.dark.scanlineAlpha },
          },
          // Frosted overlay tint + a single glow-border that doubles as
          // focus ring and phosphor accent. Hover state reuses the same
          // `panelAlpha` (callers don't need a "stronger" variant — the
          // 0.78 light / 0.72 dark looks identical against the CRT bg).
          panelAlpha: {
            value: { base: brand.light.panelAlpha, _dark: brand.dark.panelAlpha },
          },
          termGlowBorder: {
            value: { base: brand.light.termGlowBorder, _dark: brand.dark.termGlowBorder },
          },
          vignette: {
            value: { base: brand.light.vignette, _dark: brand.dark.vignette },
          },
        },
      },
      // Drop-shadow tokens for floating cards / hints / toasts. The
      // light variants drop overall opacity and shift the wash to a
      // cool blue — black drop-shadow on near-white reads as "bruised"
      // rather than "elevated". `card` stays distinct (heavier wash
      // for dialogs); `float` is the unified hint+toast cell.
      shadows: {
        card: {
          value: {
            base: '0 14px 48px rgba(20,30,60,0.18)',
            _dark: '0 14px 48px rgba(0,0,0,0.55)',
          },
        },
        float: {
          value: {
            base: '0 7px 25px rgba(20,30,60,0.19)',
            _dark: '0 7px 25px rgba(0,0,0,0.45)',
          },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
