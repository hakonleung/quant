/**
 * Chakra UI v3 system: design tokens + semantic tokens for the
 * pro-geek workbench. Everything else in the app must consume tokens
 * from here, never raw hex (CLAUDE.md §1.2).
 */

import { createSystem, defaultConfig, defineConfig, defineRecipe } from '@chakra-ui/react';

import { fonts, palette } from './tokens.js';

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
      _active: { bg: 'panel2', transform: 'none' },
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

const { light, term } = palette;

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
        // light palette
        light: {
          bg: { value: light.bg },
          panel: { value: light.panel },
          panel2: { value: light.panel2 },
          panel3: { value: light.panel3 },
          line: { value: light.line },
          line2: { value: light.line2 },
          hover: { value: light.hover },
          ink: { value: light.ink },
          ink2: { value: light.ink2 },
          ink3: { value: light.ink3 },
          amber: { value: light.amber },
          amberDark: { value: light.amberDark },
          amberBg: { value: light.amberBg },
          up: { value: light.up },
          down: { value: light.down },
          blue: { value: light.blue },
          violet: { value: light.violet },
          green: { value: light.green },
          greenBg: { value: light.greenBg },
          badgeBg: { value: light.badgeBg },
        },
        // cyber terminal palette
        term: {
          bg: { value: term.bg },
          panel: { value: term.panel },
          panel2: { value: term.panel2 },
          line: { value: term.line },
          line2: { value: term.line2 },
          ink: { value: term.ink },
          ink2: { value: term.ink2 },
          ink3: { value: term.ink3 },
          green: { value: term.green },
          greenDark: { value: term.greenDark },
          cyan: { value: term.cyan },
          magenta: { value: term.magenta },
          amber: { value: term.amber },
          red: { value: term.red },
          inputBg: { value: term.inputBg },
        },
      },
    },
    recipes: {
      monoButton: monoButtonRecipe,
    },
    semanticTokens: {
      colors: {
        // workbench surface — used everywhere except the cyber slot
        bg: { value: '{colors.light.bg}' },
        panel: { value: '{colors.light.panel}' },
        panel2: { value: '{colors.light.panel2}' },
        panel3: { value: '{colors.light.panel3}' },
        line: { value: '{colors.light.line}' },
        line2: { value: '{colors.light.line2}' },
        hover: { value: '{colors.light.hover}' },
        ink: { value: '{colors.light.ink}' },
        ink2: { value: '{colors.light.ink2}' },
        ink3: { value: '{colors.light.ink3}' },
        accent: { value: '{colors.light.amber}' },
        accentDark: { value: '{colors.light.amberDark}' },
        accentBg: { value: '{colors.light.amberBg}' },
        up: { value: '{colors.light.up}' },
        down: { value: '{colors.light.down}' },
        link: { value: '{colors.light.blue}' },
        violet: { value: '{colors.light.violet}' },
        prompt: { value: '{colors.light.green}' },
        promptBg: { value: '{colors.light.greenBg}' },
        badgeBg: { value: '{colors.light.badgeBg}' },
      },
    },
  },
});

export const system = createSystem(defaultConfig, config);
