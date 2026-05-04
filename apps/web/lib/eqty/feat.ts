/**
 * Catalogue of EQTY workbench panes.
 *
 * Each `Feat` value is a `[MODULE].[FEATURE]` string displayed in the
 * pane header (e.g. `EQ.CHART`). Module abbreviations:
 *   - SEC    sector / collection
 *   - EQ     equity (price chart, list)
 *   - SCR    screening (NL search, pattern match)
 *   - AI     LLM insight surface
 *   - SYS    system (status, push)
 *   - WATCH  live watch tasks
 *
 * `FEAT_CONFIG_MAP` is the single source of truth for static pane
 * metadata — grid placement and the `cyber` skin flag. The header
 * label IS the feat value, so no separate title field is needed.
 */

export const Feat = {
  // SEC — sector / collection
  SectorList: 'SEC.LIST',
  SectorBlack: 'SEC.BLACK',

  // EQ — equity
  EquityChart: 'EQ.CHART',
  EquityList: 'EQ.LIST',

  // SCR — screening
  ScreenNL: 'SCR.NL',
  ScreenPattern: 'SCR.PAT',

  // AI — LLM surface
  AIOut: 'AI.OUT',
  AIHist: 'AI.HIST',
  AIMd: 'AI.MD',

  // SYS — system
  SysStat: 'SYS.STAT',
  SysPush: 'SYS.PUSH',

  // WATCH — live watch tasks
  WatchLive: 'WATCH.LIVE',
} as const;

export type Feat = (typeof Feat)[keyof typeof Feat];

export interface FeatConfig {
  readonly gridArea?: string;
  readonly cyber?: boolean;
  /** When true, the pane mounts in the minimized state (header only). */
  readonly defaultMinimized?: boolean;
}

export const FEAT_CONFIG_MAP: Readonly<Record<Feat, FeatConfig>> = {
  [Feat.SectorList]: { gridArea: 'L' },
  [Feat.SectorBlack]: { defaultMinimized: true },

  [Feat.EquityChart]: { gridArea: 'CMID' },
  [Feat.EquityList]: {},

  [Feat.ScreenNL]: { cyber: true },
  [Feat.ScreenPattern]: { defaultMinimized: true },

  [Feat.AIOut]: { gridArea: 'CBOT' },
  [Feat.AIHist]: { gridArea: 'R1' },
  [Feat.AIMd]: { defaultMinimized: true },

  [Feat.SysStat]: { cyber: true, defaultMinimized: true },
  [Feat.SysPush]: { gridArea: 'R2', cyber: true, defaultMinimized: true },
  [Feat.WatchLive]: { gridArea: 'R3', cyber: true, defaultMinimized: true },
};
