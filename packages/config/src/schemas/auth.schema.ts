/**
 * Auth runtime configuration.
 *
 * Env-agnostic — callers parse `AUTH_MODE` / `NEXTAUTH_*` themselves and
 * pass the resolved shape via {@link authConfig}. The jwt session TTL
 * is hardcoded here (7 days) so we don't expose another knob.
 */

export type AuthMode = 'disabled' | 'oauth';

export interface AuthConfig {
  readonly mode: AuthMode;
  readonly nextauthSecret: string | null;
  readonly nextauthUrl: string;
  readonly dataRoot: string;
  readonly adminUserId: string;
  readonly adminUserIds: ReadonlySet<string>;
  /** Web-side JWT session TTL in seconds (also used as the cookie maxAge). */
  readonly jwtSessionTtlSec: number;
  /** Name of the httpOnly cookie that carries the session JWT. */
  readonly cookieName: string;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  mode: 'disabled',
  nextauthSecret: null,
  nextauthUrl: 'http://127.0.0.1:3000',
  dataRoot: '../../data',
  adminUserId: 'admin',
  adminUserIds: new Set<string>(),
  jwtSessionTtlSec: 60 * 60 * 24 * 7,
  cookieName: 'next-auth.session-token',
};

export function authConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return { ...DEFAULT_AUTH_CONFIG, ...overrides };
}
