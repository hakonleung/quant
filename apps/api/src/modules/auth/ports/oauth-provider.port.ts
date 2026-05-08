/**
 * Port for a server-side OAuth provider. The actual web OAuth dance runs
 * in NextAuth on the Next.js side, so this port is reserved for future
 * server-driven flows (e.g. IM bot reauth, headless device login).
 *
 * The `id` doubles as the userId namespace prefix — userIds are derived
 * as `${id}:${externalId}` (multi-tenant: `${id}:${tenantKey}:${externalId}`).
 */

export const OAUTH_PROVIDERS = Symbol('OAUTH_PROVIDERS');

export type OAuthProviderId = 'feishu' | 'github' | 'google';

export interface OAuthUserInfo {
  readonly externalId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly avatarUrl: string | null;
  readonly tenantKey: string | null;
}

export interface OAuthProvider {
  readonly id: OAuthProviderId;
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(
    code: string,
    redirectUri: string,
    traceId: string,
  ): Promise<{ accessToken: string; expiresInSec: number }>;
  fetchUserInfo(accessToken: string, traceId: string): Promise<OAuthUserInfo>;
}

/**
 * Canonical userId derivation. Single source of truth for both OAuth
 * (Web) and IM (inbound) entry points so the same human always gets
 * the same userId.
 */
export function deriveUserId(
  providerId: OAuthProviderId,
  externalId: string,
  tenantKey: string | null,
): string {
  if (tenantKey === null) return `${providerId}:${externalId}`;
  return `${providerId}:${tenantKey}:${externalId}`;
}
