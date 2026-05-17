/**
 * Catalogue of EQTY workbench panes.
 *
 * Each `Feat` value is a `[MODULE].[FEATURE]` string displayed in the
 * pane header (e.g. `EQ.CHART`). Module abbreviations:
 *   - MKT    market overview (sector roster + equity list)
 *   - EQ     equity chart
 *   - SCR    screening (NL search, pattern match)
 *   - AI     LLM insight surface
 *   - SYS    system (status + activity feed + watch outputs)
 *   - USR    user surface (ledger / watch tasks / config) — single
 *            FeatView, three tabs in the header
 *
 * `FEAT_CONFIG_MAP` is the single source of truth for static pane
 * metadata — grid placement and the `cyber` skin flag. The header
 * label IS the feat value, so no separate title field is needed.
 */

export const Feat = {
  // MKT — market overview (sector roster + equity list, one pane)
  Mkt: 'MKT',

  // EQ — equity chart
  EquityChart: 'EQ',

  // SCR — screening
  ScreenNL: 'SEARCH',
  ScreenPattern: 'PAT',
  ScreenDsl: 'SCR.DSL',

  // BT — backtest (event-study return distribution for a screen)
  BtEval: 'BT.EVAL',

  // AI — LLM surface (AI.SEC = sector aggregate, AI.EQ = single stock)
  AIEq: 'AI.EQ',
  AISec: 'AI.SEC',
  AIMd: 'AI.MD',

  // SYS — unified status + IM activity + watch outputs
  SysMain: 'SYS',

  // USR — single pane, three tabs (LDG / WATCH / CFG)
  UsrMain: 'USR',
  // Internal sub-feat ids — rendered only as the active-tab label
  // inside USR.MAIN (and as the standalone feat when used outside the
  // merged pane, if any consumer ever needs that). They never receive
  // their own grid slot or persisted view-mode entry.
  Ledger: 'LDG.MAIN',
  WatchLive: 'WATCH.LIVE',
  SysCfg: 'SYS.CFG',

  // TERM — keyboard-driven command surface
  Terminal: 'TERM.MAIN',
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
  [Feat.Mkt]: { gridArea: 'L' },

  [Feat.EquityChart]: { gridArea: 'CMID' },

  [Feat.ScreenNL]: { cyber: true },
  [Feat.ScreenPattern]: { defaultMinimized: true },
  [Feat.ScreenDsl]: {},
  [Feat.BtEval]: { defaultMinimized: true },

  [Feat.AIEq]: { cyber: true, gridArea: 'CBOT' },
  [Feat.AISec]: { cyber: true, gridArea: 'R1' },
  [Feat.AIMd]: { cyber: true, defaultMinimized: true },

  [Feat.SysMain]: { cyber: true, defaultMinimized: true, bodyOverlay: true },
  // USR lives only in the topbar — narrow chrome with no inline space,
  // so its body floats as a bodyOverlay dropdown. Removed from the
  // workbench right column (was the bottom-right pane) to avoid two
  // mount points fighting for the same persisted view-mode.
  [Feat.UsrMain]: { cyber: true, defaultMinimized: true, bodyOverlay: true },
  [Feat.Terminal]: { cyber: true, defaultMinimized: true },
  // Sub-feats (rendered as labels inside USR.MAIN). Any pane that
  // mounts them standalone would inherit `defaultMinimized: true` so
  // they don't fight USR.MAIN for vertical space if both happen to be
  // present during a transitional render.
  [Feat.Ledger]: { defaultMinimized: true },
  [Feat.WatchLive]: { cyber: true, defaultMinimized: true },
  [Feat.SysCfg]: { cyber: true, defaultMinimized: true, bodyOverlay: true },
};
