/**
 * Server-side auth config. Read once per request — no caching beyond what
 * Node already does for `process.env`. Throws if `oauth` mode is selected
 * without the required secrets so misconfiguration surfaces at boot,
 * not at the first 500.
 */

export type AuthMode = 'disabled' | 'oauth';

export interface AuthConfig {
  readonly mode: AuthMode;
  readonly nextauthSecret: string;
  readonly feishuAppId: string;
  readonly feishuAppSecret: string;
  readonly publicBaseUrl: string;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
}

const COOKIE_NAME = 'next-auth.session-token';

export function getAuthMode(): AuthMode {
  const raw = process.env['AUTH_MODE'] ?? process.env['NEXT_PUBLIC_AUTH_MODE'];
  if (raw === 'oauth') return 'oauth';
  return 'disabled';
}

export function getAuthConfig(): AuthConfig {
  const mode = getAuthMode();
  const secret = process.env['NEXTAUTH_SECRET'] ?? '';
  const appId = process.env['CHANNEL_FEISHU_APP_ID'] ?? '';
  const appSecret = process.env['CHANNEL_FEISHU_APP_SECRET'] ?? '';
  const publicBaseUrl = process.env['NEXTAUTH_URL'] ?? 'http://127.0.0.1:3000';
  const cookieSecure = publicBaseUrl.startsWith('https://');
  if (mode === 'oauth') {
    if (secret.length === 0) throw new Error('AUTH_MODE=oauth requires NEXTAUTH_SECRET');
    if (appId.length === 0 || appSecret.length === 0) {
      throw new Error('AUTH_MODE=oauth requires CHANNEL_FEISHU_APP_ID + CHANNEL_FEISHU_APP_SECRET');
    }
  }
  return {
    mode,
    nextauthSecret: secret,
    feishuAppId: appId,
    feishuAppSecret: appSecret,
    publicBaseUrl,
    cookieName: COOKIE_NAME,
    cookieSecure,
  };
}

export const ADMIN_USER_ID = 'admin';
