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
  /**
   * IM-derived userIds that should be promoted to the synthetic `admin`
   * user. Configured via `AUTH_ADMIN_USER_IDS` as a comma-separated list
   * of full prefixed ids (e.g. `feishu:ou_abc,slack:U_xyz`) — matched
   * verbatim against the inbound `sender` string built by the channel
   * adapters (`${channel}:${externalId}`).
   */
  readonly adminUserIds: ReadonlySet<string>;
}

const DEFAULT_DATA_ROOT = '../../data';
const ADMIN_USER_ID = 'admin';

function parseIdSet(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.length === 0) return new Set<string>();
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (v.length > 0) out.add(v);
  }
  return out;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfigShape {
  const mode = parseAuthMode(env['AUTH_MODE']);
  const secretRaw = env['NEXTAUTH_SECRET'];
  const secret = secretRaw !== undefined && secretRaw.length > 0 ? secretRaw : null;
  if (mode === 'oauth' && secret === null) {
    throw new Error('AUTH_MODE=oauth requires NEXTAUTH_SECRET');
  }
  return {
    mode,
    nextauthSecret: secret,
    dataRoot: env['QUANT_DATA_ROOT'] ?? DEFAULT_DATA_ROOT,
    adminUserId: ADMIN_USER_ID,
    adminUserIds: parseIdSet(env['AUTH_ADMIN_USER_IDS']),
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
