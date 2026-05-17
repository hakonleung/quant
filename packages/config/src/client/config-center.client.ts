/**
 * ClientConfigCenter — browser-safe slice.
 *
 * Env-agnostic. Callers (Next.js root layout) parse `NEXT_PUBLIC_*`
 * env themselves and hand a ready-made snapshot via
 * {@link ClientConfigCenter.hydrate}. `init` with no args yields
 * defaults — useful for SSR / tests / SSG paths with no overrides.
 */

import {
  clientConfig,
  type ClientConfig,
  type ClientConfigOverrides,
} from '../schemas/client.schema.js';

export class ClientConfigCenter {
  private static instance: ClientConfigCenter | null = null;

  private constructor(private readonly cfg: ClientConfig) {}

  static init(
    overrides: ClientConfigOverrides = {},
    options: { readonly force?: boolean } = {},
  ): ClientConfigCenter {
    if (ClientConfigCenter.instance !== null && options.force !== true) {
      return ClientConfigCenter.instance;
    }
    ClientConfigCenter.instance = new ClientConfigCenter(clientConfig(overrides));
    return ClientConfigCenter.instance;
  }

  static hydrate(snapshot: ClientConfig): ClientConfigCenter {
    ClientConfigCenter.instance = new ClientConfigCenter(snapshot);
    return ClientConfigCenter.instance;
  }

  static get(): ClientConfigCenter {
    if (ClientConfigCenter.instance === null) {
      throw new Error('ClientConfigCenter not initialised — call init() or hydrate() at bootstrap');
    }
    return ClientConfigCenter.instance;
  }

  static __resetForTests(): void {
    ClientConfigCenter.instance = null;
  }

  get auth() {
    return this.cfg.auth;
  }
  get socket() {
    return this.cfg.socket;
  }
  get terminal() {
    return this.cfg.terminal;
  }
  get ui() {
    return this.cfg.ui;
  }

  snapshot(): ClientConfig {
    return this.cfg;
  }
}
