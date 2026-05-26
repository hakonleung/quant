/**
 * Catalogue of EQTY workbench panes.
 *
 * Each `Feat` value is a `[MODULE].[FEATURE]` string displayed in the
 * pane header (e.g. `EQ.CHART`). Module abbreviations:
 *   - MKT    market overview (sector chip slider)
 *   - EQ     equity workbench (chart / info / list)
 *   - SCR    screening (NL search, pattern match, DSL editor)
 *   - BT     backtest (event-study return distribution)
 *   - AI     LLM insight surface
 *   - SYS    system (status + activity feed + watch outputs)
 *   - USR    user surface (ledger / watch tasks / config) — single
 *            FeatView, three tabs in the header
 *
 * `FEAT_CONFIG_MAP` is the single source of truth for static pane
 * metadata — the `cyber` skin flag, default-minimized state, and the
 * `bodyOverlay` flag for topbar-mounted panes. The header label IS
 * the feat value, so no separate title field is needed.
 *
 * **Floating island layout.** The workbench renders each pane as a
 * separate `<FeatView>` in column flex children — no per-Feat
 * `gridArea` placement, no parent that wraps multiple Feats under one
 * pane chrome. Splitting and re-stacking columns happens in
 * `eqty-module.tsx`.
 */

export const Feat = {
  // MKT — sector chip slider (single horizontal row)
  Mkt: 'MKT',

  // EQ — equity workbench, split into three independent panes
  EquityChart: 'EQ',
  EquityInfo: 'EQ.INFO',
  EquityList: 'EQ.LIST',

  // SCR — screening surfaces (independently mounted floating tiles)
  ScreenNL: 'SEARCH',
  ScreenPattern: 'PAT',
  ScreenDsl: 'DSL',

  // BT — backtest
  BtEval: 'BT',

  // AI — LLM surface (AI.SEC = sector aggregate, AI.EQ = single stock)
  AIEq: 'AI.EQ',
  AISec: 'AI.SEC',

  // SYS — unified status + IM activity + watch outputs
  SysMain: 'SYS',

  // Ex-USR tabs — independent topbar tiles since the 2026-05 split.
  // The old combined `USR` pane (which wrapped these three under a
  // tab strip) is gone.
  Settings: 'SET',
  Ledger: 'LDG',
  WatchLive: 'WATCH',
  // SYS.CFG is the actual settings surface — `Feat.Settings` (SET)
  // wraps it with the chrome that hosts the user chip.
  SysCfg: 'SYS.CFG',

  // Floating overlays — bottom-right dock, no fullscreen.
  Dev: 'DEV', // perf metrics (mem / fps / lcp / inp / cls)
  Scope: 'SCOPE', // active feat + keyboard hint

  // TERM — keyboard-driven command surface
  Terminal: 'TERM.MAIN',
} as const;

export type Feat = (typeof Feat)[keyof typeof Feat];

export interface FeatConfig {
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
  /**
   * Floating overlay pane: rendered by its consumer in a fixed-position
   * container (e.g. bottom-right dock) instead of participating in a
   * column flex. The pane has only two states (`minimized` /
   * `normal`) — clicking the name toggles them; the fullscreen control
   * is hidden because the pane is already detached from the layout
   * grid.
   */
  readonly floating?: boolean;
}

export const FEAT_CONFIG_MAP: Readonly<Record<Feat, FeatConfig>> = {
  // MKT — sector slider, content-sized header strip
  [Feat.Mkt]: {},

  // EQ workbench panes — all three are independent floating tiles
  [Feat.EquityChart]: {},
  [Feat.EquityInfo]: { defaultMinimized: true },
  [Feat.EquityList]: {},

  // SCR / BT — minimized by default; show up only when relevant
  [Feat.ScreenNL]: { cyber: true, defaultMinimized: true },
  [Feat.ScreenPattern]: { defaultMinimized: true },
  [Feat.ScreenDsl]: { defaultMinimized: true },
  [Feat.BtEval]: { defaultMinimized: true },

  [Feat.AIEq]: { cyber: true },
  [Feat.AISec]: { cyber: true },

  // SYS / SET / LDG / WATCH all live in the topbar — narrow chrome
  // with no inline body space, so `bodyOverlay` floats their bodies
  // as fixed-position dropdowns anchored to the header rect.
  [Feat.SysMain]: { cyber: true, defaultMinimized: true, bodyOverlay: true },
  [Feat.Settings]: { cyber: true, defaultMinimized: true, bodyOverlay: true },
  [Feat.Ledger]: { defaultMinimized: true, bodyOverlay: true },
  [Feat.WatchLive]: { cyber: true, defaultMinimized: true, bodyOverlay: true },
  [Feat.SysCfg]: { cyber: true, defaultMinimized: true, bodyOverlay: true },

  // Floating overlays — bottom-right dock, no fullscreen.
  [Feat.Dev]: { cyber: true, defaultMinimized: true, floating: true },
  [Feat.Scope]: { defaultMinimized: true, floating: true },

  [Feat.Terminal]: { cyber: true, defaultMinimized: true },
};
