/**
 * Design tokens lifted from docs/design/05-pro-geek.html.
 *
 * Two palettes coexist:
 * - `light.*` is the workbench surface (amber accent on neutral grey)
 * - `term.*` is the cyberpunk terminal slot (dark panel + neon)
 *
 * Token names are stable contract — components reference them via Chakra
 * semantic tokens, never raw hex.
 */

export const palette = {
  light: {
    bg: '#f4f5f7',
    panel: '#ffffff',
    panel2: '#fbfbfa',
    panel3: '#fafbfc',
    line: '#e3e5ea',
    line2: '#eceef2',
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
  term: {
    bg: '#06080a',
    panel: '#0a0e10',
    panel2: '#0f1417',
    line: '#1a2227',
    line2: '#23303a',
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
} as const;

export const fonts = {
  sans: '-apple-system, "SF Pro Text", Inter, system-ui, sans-serif',
  mono: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
} as const;
