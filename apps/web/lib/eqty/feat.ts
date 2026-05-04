/**
 * Catalogue of EQTY workbench panes.
 *
 * Each `Feat` is a 3-digit terminal-style id displayed in the pane
 * header (e.g. `110 PRICE CHART`). `FEAT_CONFIG_MAP` is the single
 * source of truth for static pane metadata — title, grid placement,
 * and the `cyber` skin flag — so panel components stay focused on
 * content rendering.
 */

export const Feat = {
  // C: collection
  Sectors: 'C-0',
  Blacklist: 'C-9',

  // E: Equity
  Equity: 'E-0',
  EquityList: 'E-1',

  // M: match
  Search: 'M-0',
  Pattern: 'M-1',

  // A: ai
  Insight: 'A-0',
  Insights: 'A-1',
  Markdown: 'A-2',

  // S: system
  Status: 'S-0',
  Notif: 'S-1',

  // W: watch
  Watch: 'W-0',
} as const;

export type Feat = (typeof Feat)[keyof typeof Feat];

export interface FeatConfig {
  readonly title: () => string;
  readonly gridArea?: string;
  readonly cyber?: boolean;
  /** When true, the pane mounts in the minimized state (header only). */
  readonly defaultMinimized?: boolean;
}

export const FEAT_CONFIG_MAP: Readonly<Record<Feat, FeatConfig>> = {
  [Feat.Sectors]: { title: () => 'sector', gridArea: 'L' },
  [Feat.Blacklist]: { title: () => 'blacklist', defaultMinimized: true },

  [Feat.Equity]: { title: () => 'equity', gridArea: 'CMID' },
  [Feat.EquityList]: { title: () => 'list' },

  [Feat.Search]: { title: () => 'search', cyber: true },
  [Feat.Pattern]: { title: () => 'pattern', defaultMinimized: true },

  [Feat.Insight]: { title: () => 'insight', gridArea: 'CBOT' },
  [Feat.Insights]: { title: () => 'insights', gridArea: 'R1' },
  [Feat.Markdown]: { title: () => 'markdown', defaultMinimized: true },

  [Feat.Status]: {
    title: () => 'status',
    cyber: true,
    defaultMinimized: true,
  },
  [Feat.Notif]: {
    title: () => 'slack',
    gridArea: 'R2',
    cyber: true,
    defaultMinimized: true,
  },
  [Feat.Watch]: {
    title: () => 'watch',
    gridArea: 'R3',
    cyber: true,
    defaultMinimized: true,
  },
};
