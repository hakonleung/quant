/**
 * Auth runtime configuration.
 *
 * `AUTH_MODE=disabled` (default for local dev) makes every request inherit
 * the synthetic `admin` user. `AUTH_MODE=oauth` enforces a verified
 * NextAuth-issued Bearer/cookie token. The split lives in env, not code,
 * so a single binary serves both LAN-only single-user and public
 * multi-user deployments.
 */

import { Inject, Injectable } from '@nestjs/common';

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

export type AuthMode = 'disabled' | 'oauth';

export interface AuthConfigShape {
  readonly mode: AuthMode;
  readonly nextauthSecret: string | null;
  readonly dataRoot: string;
  readonly adminUserId: string;
}

const DEFAULT_DATA_ROOT = '../../data';
const ADMIN_USER_ID = 'admin';

export function loadAuthConfig(): AuthConfigShape {
  const mode = parseAuthMode(process.env['AUTH_MODE']);
  const secretRaw = process.env['NEXTAUTH_SECRET'];
  const secret = secretRaw !== undefined && secretRaw.length > 0 ? secretRaw : null;
  if (mode === 'oauth' && secret === null) {
    throw new Error('AUTH_MODE=oauth requires NEXTAUTH_SECRET');
  }
  return {
    mode,
    nextauthSecret: secret,
    dataRoot: process.env['QUANT_DATA_ROOT'] ?? DEFAULT_DATA_ROOT,
    adminUserId: ADMIN_USER_ID,
  };
}

function parseAuthMode(raw: string | undefined): AuthMode {
  if (raw === undefined || raw.length === 0) return 'disabled';
  if (raw === 'disabled' || raw === 'oauth') return raw;
  throw new Error(`unknown AUTH_MODE=${raw} (expected 'disabled' or 'oauth')`);
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
}
