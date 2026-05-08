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

  // EQ — equity
  EquityChart: 'EQ.CHART',
  EquityList: 'EQ.LIST',

  // SCR — screening
  ScreenNL: 'SEARCH',
  ScreenPattern: 'SCR.PAT',
  ScreenDsl: 'SCR.DSL',

  // AI — LLM surface (AI.SEC = sector aggregate, AI.EQ = single stock)
  AIEq: 'AI.EQ',
  AISec: 'AI.SEC',
  AIMd: 'AI.MD',

  // SYS — system
  SysStat: 'SYS.STAT',
  SysCfg: 'SYS.CFG',

  // WATCH — live watch tasks
  WatchLive: 'WATCH.LIVE',

  // CHN — unified system + IM activity feed (replaces SYS.PUSH)
  ChannelLive: 'CHN.LIVE',

  // TERM — keyboard-driven command surface
  Terminal: 'TERM.MAIN',

  // LDG — personal ledger (daily P/L journal + AI review)
  Ledger: 'LDG.MAIN',
} as const;

export type Feat = (typeof Feat)[keyof typeof Feat];

export interface FeatConfig {
  readonly gridArea?: string;
  readonly cyber?: boolean;
  /** When true, the pane mounts in the minimized state (header only). */
  readonly defaultMinimized?: boolean;
  /**
   * When true, restoring the pane keeps the outer Box at header height
   * and floats the body as a fixed-position dropdown anchored to the
   * header. Use this for panes embedded in narrow chrome (top-bar)
   * where there is no vertical space for an inline body.
   */
  readonly bodyOverlay?: boolean;
}

export const FEAT_CONFIG_MAP: Readonly<Record<Feat, FeatConfig>> = {
  [Feat.SectorList]: { gridArea: 'L' },

  [Feat.EquityChart]: { gridArea: 'CMID' },
  [Feat.EquityList]: {},

  [Feat.ScreenNL]: { cyber: true },
  [Feat.ScreenPattern]: { defaultMinimized: true },
  [Feat.ScreenDsl]: {},

  [Feat.AIEq]: { cyber: true, gridArea: 'CBOT' },
  [Feat.AISec]: { cyber: true, gridArea: 'R1' },
  [Feat.AIMd]: { cyber: true, defaultMinimized: true },

  [Feat.SysStat]: { cyber: true, defaultMinimized: true, bodyOverlay: true },
  [Feat.SysCfg]: { cyber: true, defaultMinimized: true, bodyOverlay: true },
  [Feat.WatchLive]: { gridArea: 'R3', cyber: true, defaultMinimized: true },
  [Feat.ChannelLive]: { cyber: true, defaultMinimized: true, bodyOverlay: true },
  [Feat.Terminal]: { cyber: true, defaultMinimized: true },
  [Feat.Ledger]: { defaultMinimized: true },
};
