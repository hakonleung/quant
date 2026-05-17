/**
 * UI / browser-side defaults (react-query staleTime, toast TTLs).
 * Pure defaults — no env access. Callers wishing to override pass a
 * full or partial shape via {@link uiConfig}.
 */

export interface ReactQueryConfig {
  readonly defaultStaleTimeMs: number;
  readonly watchGroupsStaleTimeMs: number;
}

export interface NotifyToastConfig {
  readonly infoTtlMs: number;
  readonly successTtlMs: number;
  readonly warnTtlMs: number;
  readonly errorTtlMs: number | null;
}

export interface UiConfig {
  readonly reactQuery: ReactQueryConfig;
  readonly notify: NotifyToastConfig;
}

export const DEFAULT_UI_CONFIG: UiConfig = {
  reactQuery: {
    defaultStaleTimeMs: 30_000,
    watchGroupsStaleTimeMs: 60_000,
  },
  notify: {
    infoTtlMs: 4_000,
    successTtlMs: 3_000,
    warnTtlMs: 6_000,
    errorTtlMs: null,
  },
};

export interface UiConfigOverrides {
  readonly reactQuery?: Partial<ReactQueryConfig>;
  readonly notify?: Partial<NotifyToastConfig>;
}

export function uiConfig(overrides: UiConfigOverrides = {}): UiConfig {
  return {
    reactQuery: { ...DEFAULT_UI_CONFIG.reactQuery, ...(overrides.reactQuery ?? {}) },
    notify: { ...DEFAULT_UI_CONFIG.notify, ...(overrides.notify ?? {}) },
  };
}
