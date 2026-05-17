/**
 * Auth module DI token + the `AuthConfig` @Injectable adapter.
 *
 * The resolved shape lives on `ServerConfigCenter.get().auth`. The
 * module factory passes that shape through `AUTH_CONFIG`; the
 * @Injectable adapter exposes it via getter properties so legacy
 * consumers (`@Inject(AuthConfig)` in services) keep working.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { AuthMode } from '@quant/config';

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

export type { AuthMode };

export interface AuthConfigShape {
  readonly mode: AuthMode;
  readonly nextauthSecret: string | null;
  readonly dataRoot: string;
  readonly adminUserId: string;
  readonly adminUserIds: ReadonlySet<string>;
}

@Injectable()
export class AuthConfig {
  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfigShape) {}

  get mode(): AuthMode {
    return this.cfg.mode;
  }
  get dataRoot(): string {
    return this.cfg.dataRoot;
  }
  get adminUserId(): string {
    return this.cfg.adminUserId;
  }
  get nextauthSecret(): string | null {
    return this.cfg.nextauthSecret;
  }
  get adminUserIds(): ReadonlySet<string> {
    return this.cfg.adminUserIds;
  }
}
