/**
 * Watch (price-alert) module cadences and hit gating. All hardcoded —
 * tuned for the 5-second master tick + 3-second hit debounce contract
 * documented in docs/modules/06-watch.md.
 */

export interface WatchConfig {
  readonly masterTickMs: number;
  readonly broadcasterTickMs: number;
  readonly staleQuoteMaxMs: number;
  readonly hitPriceDeltaPct: number;
  readonly hitBatchWindowMs: number;
}

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  masterTickMs: 5_000,
  broadcasterTickMs: 1_000,
  staleQuoteMaxMs: 30 * 60 * 1_000,
  hitPriceDeltaPct: 2,
  hitBatchWindowMs: 3_000,
};

export function watchConfig(overrides: Partial<WatchConfig> = {}): WatchConfig {
  return { ...DEFAULT_WATCH_CONFIG, ...overrides };
}
