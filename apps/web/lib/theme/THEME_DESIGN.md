# Theme Token System — Design

> Source of truth for the unified theme refactor. See `tokens.ts` /
> `system.ts` / `use-token-color.ts` / `xterm-theme.ts` for the
> implementation that consumes this spec.

The three colour domains are **workbench** (shared surface for both
light and dark), **term** (terminal slot — now light + dark variants),
and **chart** (SVG/Canvas data visualisation). Every token path maps to
a Chakra v3 semantic token. No hex literal may live outside
`tokens.ts`.

---

## 1. Semantic token tables

> Task #6 slimmed this set from 76 → 44 cells. See "瘦身记录" below for
> the merge table. Tokens removed here are no longer emitted as
> `--chakra-colors-*` / `--chakra-shadows-*` CSS vars — callers should
> reference the canonical token listed in the merge table.

### 1.1 Workbench

| Token path | Semantic role | Light value | Dark value | Primary callers |
|---|---|---|---|---|
| `bg` | App background | `#f4f5f7` | `#0d1014` | `<html>`, `AppShell` |
| `panel` | Primary panel | `#ffffff` | `#11151b` | TopBar, pane chrome |
| `panel3` | Tertiary panel | `#fafbfc` | `#1a2129` | nested panels, badge fill, secondary panel surface |
| `line` | Sole divider color | `#e3e5ea` | `#1f2731` | borders, chart axes / grid, every panel/dialog/row inner divider |
| `hover` | Hover surface | `#f5f7fb` | `#1c232c` | list row hover |
| `ink` | Primary text | `#161a22` | `#e6ebf2` | body, distribution crosshair |
| `ink2` | Secondary text | `#5a6371` | `#a8b2c0` | labels, KDE line |
| `ink3` | Muted text | `#8e96a3` | `#6f7888` | placeholders, axis ticks/labels, dist empty state |
| `accent` | Accent amber | `#b87514` | `#e29e3a` | focus rings, crosshair line / label text, term warning glyphs |
| `accentBg` | Accent tint bg | `#fff4dd` | `#3a2810` | crosshair label bg, focused-column tint |
| `up` | Rising / error red | `#c9303f` | `#ff5566` | up candle, PnL+, login error, term error glyphs |
| `down` | Falling / prompt-success green | `#127a55` | `#3fbf86` | down candle, PnL−, CLI prompt indicator |
| `link` | Hyperlink blue | `#1e62c8` | `#5aa0ff` | links, login CTA, distribution bar stroke, range border, term info glyphs |
| `violet` | Secondary accent | `#6b4ce0` | `#9d80ff` | tag badges |

### 1.2 Term slot

In **light** mode term shifts to a desaturated forest-on-linen palette
(see §2). In **dark** mode it keeps the cyberpunk neon. Only the cells
listed below are exposed as semantic tokens — the full 16-slot ANSI
palette lives in `palette.term` / `palette.termLight` and is consumed
directly by `xterm-theme.ts` (no semantic indirection needed since the
xterm consumer is a single boundary).

| Token path | Light | Dark | Callers |
|---|---|---|---|
| `term.bg` | `#f0f2f4` | `#06080a` | TermConsole bg, HoverInfoBox bg |
| `term.panel` | `#e8ebee` | `#0a0e10` | PaneSection header bg |
| `term.bgElev` | `#d4d9df` | `#131b20` | column-manager `_hover`, hotkey hint panel, dashboard cells |
| `term.line` | `#c5cad2` | `#1a2227` | column-manager borders, deeper term borders |
| `term.ink` | `#1a2030` | `#cfead8` | UserChip name, column labels |
| `term.ink2` | `#3a4a5a` | `#7da896` | secondary labels |
| `term.ink3` | `#6a7a8a` | `#4d6c61` | header label, FILTER label |
| `term.green` | `#1a6b42` | `#5eff9c` | monoButton hover, BigLogo glow |

### 1.3 Chart / visualization

Consumed by SVG/Canvas via `useTokenColor` (§4). Not used as Chakra
props. Axes / grid / candles / crosshair / focus-range / MA overlays /
bar fill all fold onto workbench tokens (SVG callers bake alpha via
`fillOpacity` where needed). Only the two distribution stat hues that
need to coexist on the bt.eval histogram stay chart-specific.

| Token | Light | Dark | Callers |
|---|---|---|---|
| `dist.stat.mean` | `#c0147a` | `#ff3ea5` | mean-return reference line |
| `dist.stat.median` | `#007f8b` | `#00e5ff` | median-return reference line |

### 1.4 Brand / logo

| Token | Light | Dark | Callers |
|---|---|---|---|
| `brand.logoBg` | `radial-gradient(ellipse at center, #e8ede8 0%, #d8ddd8 65%, #c8cdc8 100%)` | `radial-gradient(ellipse at center, #08120c 0%, #04060a 65%, #020406 100%)` | TopBar Brand, FeatTermMain bg |
| `brand.logoColor` | `#2a4a30` | `#d4ffe2` | BigLogo, TopBar logo |
| `brand.logoGlow` | `rgba(42,74,48,0.4) 0px 0px 4px, rgba(42,74,48,0.2) 0px 0px 12px` | `rgba(155,242,182,0.8) 0px 0px 4px, …` | logo text-shadow |
| `brand.gridColor` | `rgb(80,100,80)` | `rgb(26,58,38)` | CRT grid pattern |
| `brand.scanlineAlpha` | `rgba(0,0,0,0.10)` | `rgba(0,0,0,0.32)` | CRT scanline overlay |
| `brand.panelAlpha` | `rgba(232,237,232,0.78)` | `rgba(10,14,16,0.72)` | StockDashboard `Frame`, NavPill, NavPill hover, ScopeBadge, TermMain TipsBar |
| `brand.termGlowBorder` | `rgba(42,74,48,0.18)` | `rgba(94,255,156,0.12)` | term separators, TopBar focus ring, CRT phosphor mesh |
| `brand.vignette` | `rgba(180,200,180,0.55) 0px 0px 160px inset, rgba(42,74,48,0.10) 0px 0px 60px inset` | `rgba(0,0,0,0.92) 0px 0px 220px inset, rgba(0,80,40,0.3) 0px 0px 90px inset` | CRT overlay vignette boxShadow |

### 1.5 Surface scrim / shadow (workbench-shared)

| Token | Light | Dark | Callers |
|---|---|---|---|
| `overlay` | `rgba(20,24,32,0.32)` | `rgba(15,17,22,0.55)` | modal / dialog scrim |
| `shadow.card` | `0 14px 48px rgba(20,30,60,0.18)` | `0 14px 48px rgba(0,0,0,0.55)` | dialogs, login card |
| `shadow.float` | `0 7px 25px rgba(20,30,60,0.19)` | `0 7px 25px rgba(0,0,0,0.45)` | shortcut hint window, notification toasts |

Notes:
- `overlay` lives under `semanticTokens.colors` because Chakra resolves the `bg` prop against the color registry.
- `card` / `float` live under `semanticTokens.shadows` so Chakra's `boxShadow="card"` resolves to `--chakra-shadows-card`.

---

## 1.6 瘦身记录 (76 → 44 → 43 → 36 → 35)

The previous spec had near-duplicate tokens for "accent + accent-pressed"
(`accent` vs `accentDark`), "panel 2 vs 3" (`panel2` vs `panel3`), three
separate shadow stops (`card` / `hint` / `toast`), and a parallel
`chart.*` / `dist.*` / `term.*` ANSI / `brand.*` shadow rail for every
surface that already had a workbench equivalent. Collapsing onto the
canonical token preserves the user-visible hue while halving the cells
the theme system has to ship.

| Removed semantic token | Replacement (new caller value) | Notes |
|---|---|---|
| `line2` (task #7) | `line` | the two-step border read as visual noise — callers can't actually distinguish them. One divider color is enough; chart MA / accent / up / down already carry the "this border means something" weight |
| `panel2` | `panel3` | both already neutral-card; near-identical hex within mode |
| `accentDark` | `accent` (callers use `opacity:0.85` for pressed state) | press-state darken handled by alpha, not a separate hue |
| `badgeBg` | `panel3` | same neutral tint |
| `promptBg` | (removed — no caller carried) | unused after audit |
| `prompt` (color) | `down` | same green-success family; no caller needed both |
| `danger` | `up` | already an alias of `up` |
| `overlayStrong` | (removed — no caller carried) | only `overlay` ever used |
| `term.panel2` | `term.bgElev` | one elevated term surface is enough |
| `term.line2` | `term.line` | callers can't tell the two-step border apart |
| `term.cyan` | `link` | `$` prompt + info glyphs map to the workbench link colour |
| `term.amber` | `accent` | warning glyph = workbench accent |
| `term.red` | `up` | error glyph = workbench error red |
| `term.greenDark` / `term.magenta` / `term.inputBg` | (raw `palette.term.*` only) | only `xterm-theme.ts` consumed these — no semantic indirection needed |
| `chart.candle.up` | `up` | already aliased |
| `chart.candle.down` | `down` | already aliased |
| `chart.axis.line` / `chart.grid.line` | `line` | workbench divider already matches |
| `chart.axis.tick` / `chart.axis.label` | `ink3` | muted-text token already at the right contrast |
| `chart.focus.bg` | `accentBg` | accent-tint bg already exists |
| `chart.focus.rangeBorder` | `link` | rgba variant of the workbench link blue |
| `chart.ma.fast` (task #8) | `link` | MA5 = workbench blue |
| `chart.ma.short` (task #8) | `accent` | MA10 = workbench amber |
| `chart.ma.mid` (task #8) | `violet` | MA20 reused tag-badge purple (was unique pink hex) |
| `chart.ma.slow` (task #8) | `down` | MA60 = workbench success green |
| `chart.focus.range` (task #8) | `link` (SVG applies `fillOpacity={0.06}`) | killed the rgba-with-alpha indirection — caller bakes the opacity at draw time |
| `dist.stat.zero` (task #8) | `ink3` | neutral grey reference = workbench muted text; distinct from KDE's `ink2` |
| `dist.stat.baseline` (task #8) | `accent` | amber strategy baseline = workbench accent |
| `dist.bar.fill` (task #8) | `ink2` (SVG applies `fillOpacity={0.35}`) | same trick as `chart.focus.range` — alpha baked at draw time, not at token level |
| `chart.crosshair.line` / `.labelText` | `accent` | crosshair hue = workbench accent |
| `chart.crosshair.labelBg` | `accentBg` | same |
| `dist.empty.text` | `ink3` | muted-text |
| `dist.kde.line` | `ink2` | secondary-text |
| `dist.crosshair` | `ink` | primary-text |
| `dist.bar.stroke` | `link` | workbench link blue |
| `brand.panelAlphaStrong` | `brand.panelAlpha` | the 0.78/0.72 variant covers both rest + hover |
| `brand.tipsBarBg` | `brand.panelAlpha` | TipsBar frosted tint = nav frosted tint |
| `brand.termFocusRing` / `brand.phosphorDot` | `brand.termGlowBorder` | one glow-border tint covers focus ring + phosphor mesh |
| `shadow.hint` / `shadow.toast` | `shadow.float` | one floating-elevation shadow covers hints + toasts |

The CHART_COLOR_PATHS / DIST_COLOR_PATHS arrays in `chart-canvas.tsx`
and `return-distribution-stack.tsx` keep their positional contract
with the `ChartColors` / `DistColors` struct field names — only the
path strings rotate to point at the canonical tokens above.

---

## 2. Light-term design rationale

The term slot currently uses the cyberpunk dark palette regardless of
the workbench theme. In light mode this produces a jarring black
island. The new light-term values follow three principles:

1. **Desaturated forest-on-linen, not pure greys.** Backgrounds use
   `#f0f2f4` (cool-grey tint) and text `#1a2030` (near-black blue-toned).
   The cooler hue still reads as "different zone" without breaking the
   workbench's warm `#f4f5f7`.
2. **Hue-shifted accents, not neutralised.** `term.green` →
   `#1a6b42` (deep forest), `term.cyan` → `#0068a8` (indigo teal),
   `term.amber` → `#b05500` (burnt sienna). Each is the dark neon
   mapped down in lightness while staying in the same hue family —
   the user still reads "green glyph" semantically.
3. **WCAG AA throughout.** `term.ink` on `term.bg` ~13:1 (AAA),
   `term.ink2` ~7:1, `term.ink3` ~4.7:1, `term.green` ~5.8:1.

Monospace identity is preserved via typography (`geek`/`mono` fonts
unchanged) and density (no spacing changes). Brand cells (`brand.*`)
keep a forest-green CRT aesthetic even in light mode — the BigLogo
and TopBar Brand stay "still a terminal slot".

---

## 3. Chakra v3 semantic-token pattern

Chakra v3 conditional values: `{ value: { base: lightHex, _dark: darkHex } }`.
The `_dark` condition fires when the element is inside a `.dark`
container (Chakra's default selector is `.dark &, .dark .chakra-theme:not(.light) &` — it does NOT inspect `color-scheme` or `data-theme`). The theme sync hook in
`shell/app-shell.tsx::useThemeAttribute` therefore both sets
`<html data-theme="...">` (for native `color-scheme` + non-Chakra
CSS consumers) AND toggles `<html class="dark|light">` so the Chakra
tokens actually flip. The `globals.css` `[data-theme='dark']` rule
keeps `color-scheme: dark` for form controls / scrollbars; it is no
longer responsible for the Chakra token rewrite.

```ts
semanticTokens: {
  colors: {
    bg:    { value: { base: light.bg,    _dark: dark.bg } },
    panel: { value: { base: light.panel, _dark: dark.panel } },
    accent:{ value: { base: light.amber, _dark: dark.amber } },
    'term.bg':  { value: { base: termLight.bg,  _dark: term.bg } },
    'term.ink': { value: { base: termLight.ink, _dark: term.ink } },
    'chart.ma.fast': { value: { base: '#2563eb', _dark: '#3b82f6' } },
    'dist.stat.mean':{ value: { base: '#c0147a', _dark: '#ff3ea5' } },
  },
}
```

A new `termLight` sub-object joins `light` / `dark` / `term` in
`tokens.ts`. The `term` sub-object stays as-is.

---

## 4. `useTokenColor(path)` hook

```ts
// apps/web/lib/theme/use-token-color.ts
export function useTokenColor(tokenPath: string): string
export function useTokenColors(paths: readonly string[]): readonly string[]
```

- `tokenPath` is a dot-separated semantic token name, e.g.
  `'chart.ma.fast'`. Dots → hyphens → `--chakra-colors-chart-ma-fast`.
- Reads `getComputedStyle(document.documentElement).getPropertyValue(...)`
  inside a `useSyncExternalStore` snapshot or `useEffect` watching
  `theme` (not on every render).
- Subscribes to `useSettingsStore` for `theme` — re-reads when it flips.
- SSR-safe: returns the hardcoded light hex when `typeof document === 'undefined'`.
- `useTokenColors(paths)` batches reads into a single
  `getComputedStyle` call. Chart consumers should use it instead of
  N hook calls.
- These hooks are the **only** permitted way for SVG/Canvas code to
  obtain theme-aware colours. Direct `getComputedStyle` is banned
  outside this module.

---

## 5. xterm.js theme switching

xterm `Terminal` instances expose `term.options.theme` for runtime
reassignment — no instance teardown, no scroll-buffer loss.

```ts
// apps/web/lib/theme/xterm-theme.ts
import type { ITheme } from '@xterm/xterm';
import { palette } from './tokens.js';
import type { ThemeMode } from '@quant/shared';

export function buildXtermTheme(mode: ThemeMode): ITheme
```

Pure function, no IO. Maps mode to the 16 ANSI slot values from
`palette.term` (dark) or `palette.termLight` (light). Wiring in
`use-term-console.ts`:

```ts
termRef.current.options.theme = buildXtermTheme(currentTheme);
const unsubTheme = useSettingsStore.subscribe(
  (s) => s.theme,
  (theme) => {
    if (termRef.current) {
      termRef.current.options.theme = buildXtermTheme(theme);
    }
  },
);
// cleanup: unsubTheme()
```

ANSI slot map:

| Slot | Dark (palette.term) | Light (termLight) |
|---|---|---|
| background | `#06080a` | `#f0f2f4` |
| foreground | `#cfead8` | `#1a2030` |
| cursor | `#5eff9c` | `#1a6b42` |
| cursorAccent | `#06080a` | `#f0f2f4` |
| selectionBackground | `#1f8a4f` | `#c5d8c9` |
| black | `#0a0e10` | `#e4e8ec` |
| red | `#ff4d6d` | `#b82231` |
| green | `#5eff9c` | `#1a6b42` |
| yellow | `#ffc14d` | `#b05500` |
| blue | `#5cf2ff` | `#0068a8` |
| magenta | `#ff5cd1` | `#8b1a6a` |
| cyan | `#5cf2ff` | `#0068a8` |
| white | `#cfead8` | `#1a2030` |
| brightBlack | `#4d6c61` | `#8a9aaa` |
| brightRed–White | same as non-bright | same as non-bright |

---

## 6. Native → Chakra mapping

| File | Element | Replacement |
|---|---|---|
| `app/login/page.tsx` | `<main style={{ background:'#0b0d10', ... }}>` | `var(--chakra-colors-bg)` etc. |
| `app/login/page.tsx` | `<div style={{ background:'#11151b', border:'1px solid #1f2937' }}>` | `var(--chakra-colors-panel)` / `var(--chakra-colors-line)` |
| `app/login/page.tsx` | `<h1 style={{ fontSize:22 }}>` | `<Box as="h1" fontSize="22px" color="ink">` |
| `app/login/page.tsx` | `<p style={{ color:'#9ca3af' }}>` | `<Box as="p" color="ink2">` |
| `app/login/page.tsx` | `<a style={{ background:'#2563eb', color:'#fff' }}>` | `var(--chakra-colors-link)` |
| `app/login/page.tsx` | `<p style={{ color:'#ef4444' }}>` (error) | `color="danger"` |
| `feat-ledger/ledger-chart.tsx` | `<div>{tooltip.lineN}</div>` | `<Box as="div">` (parent owns colours) |
| `feat-eq-list/column-manager.tsx` | `<select style={SELECT_STYLE}>` | keep `<select>` (form ctrl), but reduce `SELECT_STYLE` to a helper that derives CSS var names from token paths so renames propagate |
| `shell/user-chip.tsx` | `<form>` + native `<button style>` | No change — `color:'inherit'` is the correct token-inheriting reset; not bypassing any colour token |
| `shell/app-shell.tsx` | `<a href="#main-content">` (skip-link) | No change — `.skip-link` CSS already uses `var(--chakra-colors-panel)` / `var(--chakra-colors-accent)` which auto-flip once §3 lands |

---

## 7. File-change manifest

### Task #2 — theme infrastructure

| File | Change |
|---|---|
| `lib/theme/tokens.ts` | Add `termLight` (17 keys) and `brand` (5 keys, light + dark) sub-objects. |
| `lib/theme/system.ts` | Destructure `{ light, dark, term, termLight, brand }`. Every semantic token becomes `{ value: { base, _dark } }`. Add `term.*`, `chart.*`, `dist.*`, `brand.*` semantic tokens. |
| `app/globals.css` | Delete the `[data-theme='dark'] { --chakra-colors-*: ... }` block. Keep `color-scheme` rules and the rest. |
| `lib/theme/xterm-theme.ts` | New. Exports `buildXtermTheme(mode)`. |
| `lib/theme/use-token-color.ts` | New. Exports `useTokenColor` / `useTokenColors`. |
| `lib/theme/index.ts` | New barrel. |

### Task #3 — business component migration

| File | Change |
|---|---|
| `app/login/page.tsx` | Inline `style` → CSS-var references; `h1` / `p` → `Box as=`. |
| `feat-eq-chart/chart-canvas-constants.ts` | `MA_COLORS` → `MA_COLOR_PATHS` + `getMaColors(tokens)`. |
| `feat-eq-chart/chart-canvas.tsx` | `useTokenColors(MA_COLOR_PATHS)` → pass into `ChartSvg`. |
| `feat-eq-chart/chart-canvas-svg.tsx` | Accept colour props; drop `palette` import. |
| `feat-eq-chart/chart-svg-pieces.tsx` | Accept colour props; drop `palette` import. |
| `feat-bt-eval/return-distribution-pieces.tsx` | Constants → `DistColors` props. |
| `feat-bt-eval/return-distribution-stack.tsx` (or chart) | `useTokenColors` for all `dist.*`; build `DistColors`. |
| `feat-term-main/big-logo.tsx` | `LOGO_COLOR` / `LOGO_GLOW` → `useTokenColor('brand.*')`. |
| `shell/top-bar.tsx` | `TERM_BG` / `TERM_LOGO_*` constants → `useTokenColor('brand.*')`. |
| `term-console/use-term-console.ts` | Inline xterm theme → `buildXtermTheme(theme)` + subscribe to theme store. |
| `feat-eq-list/column-manager.tsx` | `SELECT_STYLE` → token-path-driven CSS-var lookup helper. |

---

## 8. Surface & border hierarchy (task #7)

Three workbench surface tokens (`bg` / `panel` / `panel3`) and ONE divider token (`line`). Anything that "feels like it needs another shade" is almost always solved by spacing, weight, or border — not by introducing a new token.

### 8.1 Surface tokens

| Token | Role | Typical callers |
|---|---|---|
| `bg` | App background; nothing else sits on it directly | `<html>` / `<body>`, `AppShell` root |
| `panel` | Primary card surface — every dialog / pane / button-row sits on `panel` by default | dialog cards, FeatView body, primary chart canvas, top-level inputs |
| `panel3` | Subtly-elevated section chrome — narrowly used to call out a header/footer bar inside a `panel` card, a sticky table header, or a scrollable inset well | dialog headers, dialog footers, sticky `ColumnHeader`, FocusLabel strip above a chart, FUNDAMENTALS strip below a chart, DslTree preview well |
| `hover` | Row hover state | list-row hover, picker-row hover |

Rules:
- A dialog or pane's outermost card is **always** `panel`. Never `panel3`.
- Inner content (form rows, list rows, body text) inherits `panel` from the card — do NOT set `bg` again.
- Reach for `panel3` only when the section legitimately needs to read as "header chrome", "footer chrome", "sticky table header", or a scrollable inset well sitting on top of the card.
- Two siblings both `panel3` are fine when they sandwich a `panel` body (header + footer pattern). Two adjacent `panel3` regions with no `panel` between them is a smell — collapse one to `panel`.
- Inputs / textareas inside a `panel3` strip often invert (`bg="panel"` on the input) so the field reads as brighter than the strip. That's intentional, not a violation.

### 8.2 Border / divider

- `line` is the **only** divider color. There is no `line2` / `line3`. The previous two-step border (`line` + `line2`) read as visual noise — callers couldn't actually tell which one they were looking at.
- Hot borders (`accent`, `up`, `down`, `link`) are not "another line" — they're a different semantic dimension (focus / state / direction).
- For a horizontal rule that needs to stand out more, increase `borderTopWidth` to `2px` and use `borderColor="line"` — don't reach for a different hue.

### 8.3 `bg="line"` divider trick

When a 1-px Chakra border can't be used (e.g. inside a grid with a sticky cell that needs its own background, or a vertical divider between two flex children that already own their padding), set a child `<Box w="1px" h="..." bg="line" />`. Reuses the same divider color as every other border and auto-flips between light/dark with no extra wiring.

Anti-pattern: `<Box border="1px solid #eaecef">` — hex bypasses the token system; `<Box borderRight="1px solid var(--chakra-colors-line)">` is permitted but `borderRightWidth="1px" borderColor="line"` is the canonical form.
| `app/layout.tsx` | `themeColor` light/dark hex → keep but document as mirror of `bg` token (no functional change). |
