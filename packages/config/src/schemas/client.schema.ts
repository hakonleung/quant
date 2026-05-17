/**
 * Browser-visible client config. Pure shape — callers (Next.js) parse
 * `NEXT_PUBLIC_*` env keys themselves and hand the resolved snapshot
 * to {@link ClientConfigCenter.hydrate}.
 */

import {
  DEFAULT_UI_CONFIG,
  type UiConfig,
  type UiConfigOverrides,
  uiConfig,
} from './ui.schema.js';
import type { AuthMode } from './auth.schema.js';

export interface ClientAuthConfig {
  readonly mode: AuthMode;
}

export type TerminalRunnerKind = 'live' | 'mock';

export interface ClientSocketConfig {
  /**
   * Explicit socket URL override. `null` is a semantic value meaning
   * "compute from `window.location.*` at runtime"; not a missing
   * default. Callers must branch on it.
   */
  readonly url: string | null;
  /** Port suffix used when `url` is null and the browser builds the URL. */
  readonly apiPort: string;
}

export interface ClientTerminalConfig {
  readonly defaultRunner: TerminalRunnerKind;
}

export interface ClientConfig {
  readonly auth: ClientAuthConfig;
  readonly socket: ClientSocketConfig;
  readonly terminal: ClientTerminalConfig;
  readonly ui: UiConfig;
}

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  auth: { mode: 'disabled' },
  socket: { url: null, apiPort: '3001' },
  terminal: { defaultRunner: 'live' },
  ui: DEFAULT_UI_CONFIG,
};

export interface ClientConfigOverrides {
  readonly auth?: Partial<ClientAuthConfig>;
  readonly socket?: Partial<ClientSocketConfig>;
  readonly terminal?: Partial<ClientTerminalConfig>;
  readonly ui?: UiConfigOverrides;
}

export function clientConfig(overrides: ClientConfigOverrides = {}): ClientConfig {
  return {
    auth: { ...DEFAULT_CLIENT_CONFIG.auth, ...(overrides.auth ?? {}) },
    socket: { ...DEFAULT_CLIENT_CONFIG.socket, ...(overrides.socket ?? {}) },
    terminal: { ...DEFAULT_CLIENT_CONFIG.terminal, ...(overrides.terminal ?? {}) },
    ui: uiConfig(overrides.ui ?? {}),
  };
}
