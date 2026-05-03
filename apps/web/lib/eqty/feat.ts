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
  Search: '000',
  List: '001',
  Sectors: '002',
  Blacklist: '003',
  Detail: '100',
  Chart: '101',
  Blotter: '102',
  Stdout: '103',
  SlackPush: '200',
  TaskQueue: '300',
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
  [Feat.List]: { title: () => 'list' },
  [Feat.Sectors]: { title: () => 'sector', gridArea: 'L' },
  [Feat.Blacklist]: { title: () => 'blacklist', defaultMinimized: true },
  [Feat.Detail]: { title: () => 'equity', gridArea: 'CTOP' },
  [Feat.Chart]: { title: () => 'price', gridArea: 'CMID' },
  [Feat.Blotter]: { title: () => 'screen', gridArea: 'CBOT' },
  [Feat.Stdout]: { title: () => 'sentiment', gridArea: 'R1' },
  [Feat.SlackPush]: {
    title: () => 'slack.push',
    gridArea: 'R2',
    cyber: true,
    defaultMinimized: true,
  },
  [Feat.TaskQueue]: {
    title: () => 'task.queue',
    gridArea: 'R3',
    cyber: true,
    defaultMinimized: true,
  },
  [Feat.Search]: { title: () => 'search', cyber: true },
};
