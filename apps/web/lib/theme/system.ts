/**
 * Chakra UI v3 system: design tokens + semantic tokens for the
 * Liquid Glass workbench. Everything else in the app must consume
 * tokens from here, never raw hex (CLAUDE.md §1.2).
 *
 * Theme switching is driven by Chakra's `_dark` conditional value, which
 * fires when `color-scheme: dark` is on the element. `globals.css`
 * just maps `[data-theme='dark'] → color-scheme: dark`; every colour
 * token below auto-flips. No hand-rolled CSS-var override block.
 *
 * Token surface (post task #16 — Liquid Glass × 中国传统色):
 *   - `colors.*`  workbench surfaces (clean Apple gray) + 中国 accents
 *   - `colors.term.*`  frosted-glass terminal slot
 *   - `colors.glass.*`  semi-transparent glass cells for floats
 *   - `colors.brand.*`  CRT chrome (dialled-down for glass coexistence)
 *   - `fontSizes.*`  Apple-style type scale (11/12/13/15/17/22/28)
 *   - `radii.*`  Apple-style radius scale (4/8/12/16/22)
 *   - `shadows.*`  layered Apple-style elevation shadows
 */

import { createSystem, defaultConfig, defineConfig, defineRecipe } from '@chakra-ui/react';

import { fonts, fontSizes, palette, radii } from './tokens.js';

const { light, dark, term, termLight, brand, glass } = palette;

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
      color: '{colors.ink}',
      fontFamily: '{fonts.body}',
      // 13 px on the workbench is the legibility sweet spot — the
      // dense table chrome stays compact, but body prose / form
      // labels regain enough x-height to read for hours. Mobile gets
      // a 1-px nudge in `app/globals.css`. Apple SF Pro renders
      // slightly tighter than Inter, so 13px → 14px translation on
      // mobile carries over.
      fontSize: '{fontSizes.body}',
      lineHeight: '1.5',
      // Apple HIG: enable optical sizing + grayscale antialiasing so
      // SF Pro on non-retina screens stays crisp without sub-pixel
      // colour fringing.
      WebkitFontSmoothing: 'antialiased',
      MozOsxFontSmoothing: 'grayscale',
      textRendering: 'optimizeLegibility',
      fontFeatureSettings: '"ss01", "cv11"', // SF Pro stylistic alt + alt 0
    },
    /**
     * Liquid Glass ambient canvas — the layered radial gradients
     * underneath every workbench surface are what make the frosted
     * glass actually *visible*. Without them, a `rgba(255,255,255,0.72)`
     * panel on a solid `#F5F5F7` bg looks identical to a solid panel.
     *
     * The light wash uses three soft accents (cinnabar tint + jade
     * tint + indigo tint) at very low alpha so the canvas reads as
     * "ambient daylight on a colored wallpaper". Dark mode mirrors
     * with the same hues at higher saturation, evoking deep ink
     * with a warm seal-stamp glow.
     */
    body: {
      bg: '{colors.bg}',
      minHeight: '100dvh',
      // No body backgroundImage — the wallpaper is rendered by the
      // `<PageBackdrop>` component (a fixed-position `z-index:-1`
      // remount of `CrtBackdrop` at viewport scale). One source of
      // truth, theme-aware via `useTokenColor`, exact same recipe as
      // the brand logo.
    },
    '*': { boxSizing: 'border-box' },
    '.num, .mono': {
      fontFamily: '{fonts.mono}',
      fontFeatureSettings: '"tnum" 1',
      fontVariantNumeric: 'tabular-nums',
    },
    '.blink': { animation: 'blink 1s steps(2) infinite' },
    // Liquid Glass utility class — apply with `className="glass"` on
    // a Box to get the standard frosted glass surface. Equivalent to
    // setting `bg="glass.panel"` + `backdropFilter="..."` manually,
    // but cuts the boilerplate at every dialog / popover call site.
    '.glass': {
      backgroundColor: '{colors.glass.panel}',
      backdropFilter: 'blur(16px) saturate(180%)',
      WebkitBackdropFilter: 'blur(16px) saturate(180%)',
      borderColor: '{colors.glass.line}',
    },
    '.glass-strong': {
      backgroundColor: '{colors.glass.panelStrong}',
      backdropFilter: 'blur(24px) saturate(180%)',
      WebkitBackdropFilter: 'blur(24px) saturate(180%)',
      borderColor: '{colors.glass.lineStrong}',
    },
    '.glass-soft': {
      backgroundColor: '{colors.glass.panelSoft}',
      backdropFilter: 'blur(30px) saturate(160%)',
      WebkitBackdropFilter: 'blur(30px) saturate(160%)',
      borderColor: '{colors.glass.line}',
    },
  },
  theme: {
    tokens: {
      fonts: {
        body: { value: fonts.sans },
        heading: { value: fonts.sans },
        mono: { value: fonts.mono },
        geek: { value: fonts.geek },
        pixel: { value: fonts.pixel },
      },
      // Apple-style type scale. Reference via `fontSize="md"` etc. in
      // Chakra props; the workbench default body is `body` (13px).
      fontSizes: {
        xs: { value: fontSizes.xs },
        sm: { value: fontSizes.sm },
        body: { value: fontSizes.body },
        md: { value: fontSizes.md },
        lg: { value: fontSizes.lg },
        xl: { value: fontSizes.xl },
        '2xl': { value: fontSizes['2xl'] },
      },
      // Apple-style radius scale. FeatView panes intentionally stay
      // `radii.none` to preserve the geek angle markers; dialogs /
      // popovers / inputs use `sm` / `md` / `lg`.
      radii: {
        none: { value: radii.none },
        xs: { value: radii.xs },
        sm: { value: radii.sm },
        md: { value: radii.md },
        lg: { value: radii.lg },
        xl: { value: radii.xl },
        pill: { value: radii.pill },
      },
      /**
       * Unified z-index scale (`tokens.zIndex`, not semanticTokens —
       * Chakra v3 only emits `--chakra-z-index-*` CSS vars for the
       * `tokens.zIndex` slot). Every `position:fixed` surface MUST
       * pull from here. Numerical gaps between layers leave room for
       * future inserts without renumbering.
       *
       * Layer order, low → high:
       *   base       0      default
       *   sticky     100    sticky table headers, sticky toolbars
       *   dropdown   900    inline select dropdowns
       *   overlay    1000   pane bodyOverlay anchored to chrome
       *   dialog     1200   regular modal dialogs (NewSector, etc)
       *   scrim      1300   modal scrim wash
       *   modal      1400   above-scrim modal contents (confirm)
       *   fullscreen 1500   FeatView fullscreen
       *   toast      1600   FeatNotify toast / notification queue
       *   hint       1700   FeatHotkeyHint window
       *   scopeBadge 1700   ScopeBadge floating pill (same layer as hint)
       *   tooltip    1800   text tooltips (top-most)
       */
      zIndex: {
        base: { value: 0 },
        sticky: { value: 100 },
        dropdown: { value: 900 },
        overlay: { value: 1000 },
        dialog: { value: 1200 },
        scrim: { value: 1300 },
        modal: { value: 1400 },
        fullscreen: { value: 1500 },
        toast: { value: 1600 },
        hint: { value: 1700 },
        scopeBadge: { value: 1700 },
        tooltip: { value: 1800 },
      },
      colors: {
        // Raw workbench palette kept for legacy semantic references and
        // any business component that still imports `palette.light.*`.
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
      },
    },
    recipes: {
      monoButton: monoButtonRecipe,
    },
    semanticTokens: {
      colors: {
        // ---- workbench surfaces (auto-flips on color-scheme: dark)
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
        // `up` doubles as `danger`: stocks-up red and form-error red are
        // intentionally the same hue (CN market convention + design economy).
        up: { value: { base: light.up, _dark: dark.up } },
        // `down` doubles as the CLI prompt-success green.
        down: { value: { base: light.down, _dark: dark.down } },
        link: { value: { base: light.blue, _dark: dark.blue } },
        violet: { value: { base: light.violet, _dark: dark.violet } },

        // Backdrop scrim for modals / popovers. Both modes use a
        // translucent wash; the light variant is intentionally lighter
        // so a frosted glass card on top of it doesn't lose contrast.
        overlay: { value: { base: 'rgba(20,22,28,0.28)', _dark: 'rgba(0,0,0,0.55)' } },

        // ---- Liquid Glass surfaces. Pair with backdrop-filter (or
        // use the `.glass` / `.glass-strong` / `.glass-soft` utility
        // classes from globalCss). `panel` = standard cards,
        // `panelStrong` = dialog / strong popover, `panelSoft` = chrome
        // strip on top of busy content.
        glass: {
          panel: { value: { base: glass.light.panel, _dark: glass.dark.panel } },
          panelStrong: {
            value: { base: glass.light.panelStrong, _dark: glass.dark.panelStrong },
          },
          panelSoft: {
            value: { base: glass.light.panelSoft, _dark: glass.dark.panelSoft },
          },
          line: { value: { base: glass.light.line, _dark: glass.dark.line } },
          lineStrong: {
            value: { base: glass.light.lineStrong, _dark: glass.dark.lineStrong },
          },
          highlight: {
            value: { base: glass.light.highlight, _dark: glass.dark.highlight },
          },
        },

        // ---- term slot (frosted glass — light + dark variants)
        // Same shape as before; only the underlying palette values
        // changed (`palette.term` / `palette.termLight` now ship glass
        // alpha values that need backdrop-filter on the container).
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

        // ---- brand / logo CRT chrome (dialled down for glass coexistence)
        brand: {
          logoBg: { value: { base: brand.light.logoBg, _dark: brand.dark.logoBg } },
          logoColor: { value: { base: brand.light.logoColor, _dark: brand.dark.logoColor } },
          logoGlow: { value: { base: brand.light.logoGlow, _dark: brand.dark.logoGlow } },
          gridColor: { value: { base: brand.light.gridColor, _dark: brand.dark.gridColor } },
          scanlineAlpha: {
            value: { base: brand.light.scanlineAlpha, _dark: brand.dark.scanlineAlpha },
          },
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
      // Apple-style layered elevation shadows. The light variants stay
      // cool-bluish (pure black on near-white reads as "bruised");
      // dark variants combine a heavier wash with a 1-px white inset
      // highlight so cards read as "glass with a lit top edge".
      shadows: {
        // Hairline elevation — buttons, inputs.
        xs: {
          value: {
            base: '0 1px 2px rgba(15,17,22,0.06), 0 1px 1px rgba(15,17,22,0.04)',
            _dark: '0 1px 2px rgba(0,0,0,0.40), 0 1px 1px rgba(0,0,0,0.25)',
          },
        },
        // Card / dropdown elevation.
        sm: {
          value: {
            base: '0 4px 12px rgba(15,17,22,0.08), 0 1px 3px rgba(15,17,22,0.04)',
            _dark: '0 4px 12px rgba(0,0,0,0.45), 0 1px 3px rgba(0,0,0,0.30)',
          },
        },
        // Popover / menu elevation.
        md: {
          value: {
            base: '0 8px 24px rgba(15,17,22,0.10), 0 2px 6px rgba(15,17,22,0.05)',
            _dark: '0 8px 24px rgba(0,0,0,0.50), 0 2px 6px rgba(0,0,0,0.32)',
          },
        },
        // Dialog elevation.
        lg: {
          value: {
            base: '0 20px 60px rgba(15,17,22,0.18), 0 4px 16px rgba(15,17,22,0.08)',
            _dark: '0 20px 60px rgba(0,0,0,0.65), 0 4px 16px rgba(0,0,0,0.40)',
          },
        },
        // Glass surfaces — same as `sm` / `lg` but with an inset
        // white highlight baked in so the top edge catches "light".
        glass: {
          value: { base: glass.light.shadow, _dark: glass.dark.shadow },
        },
        glassStrong: {
          value: { base: glass.light.shadowStrong, _dark: glass.dark.shadowStrong },
        },
        // Legacy aliases kept to avoid touching every caller in one
        // shot. `card` ≈ `lg`, `float` ≈ `md` — the older two-stop
        // shadow set still resolves to the right elevation.
        card: {
          value: {
            base: '0 20px 60px rgba(15,17,22,0.18), 0 4px 16px rgba(15,17,22,0.08)',
            _dark: '0 20px 60px rgba(0,0,0,0.65), 0 4px 16px rgba(0,0,0,0.40)',
          },
        },
        float: {
          value: {
            base: '0 8px 24px rgba(15,17,22,0.10), 0 2px 6px rgba(15,17,22,0.05)',
            _dark: '0 8px 24px rgba(0,0,0,0.50), 0 2px 6px rgba(0,0,0,0.32)',
          },
        },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
