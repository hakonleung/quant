/**
 * GET /api/auth/callback/feishu?code=…&state=…
 *
 * Verifies the CSRF `state` cookie, exchanges the auth code for a Feishu
 * user_access_token (via app_access_token), reads the user profile, and
 * mints our internal session JWT into an httpOnly cookie. Then notifies
 * the NestJS API so the user record's `lastLoginAt` updates and the
 * imBootstrap state lifts.
 */

import { NextResponse } from 'next/server.js';

import { getAuthConfig } from '../../../../../lib/auth/config.js';
import { exchangeCodeForProfile } from '../../../../../lib/auth/feishu-provider.js';
import { mintSession, SESSION_COOKIE_MAX_AGE_SEC } from '../../../../../lib/auth/session.js';

const STATE_COOKIE = 'next-auth.feishu-state';

export async function GET(req: Request): Promise<Response> {
  const cfg = getAuthConfig();
  if (cfg.mode === 'disabled') {
    return NextResponse.redirect(new URL('/', req.url));
  }
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (code === null || state === null) {
    return NextResponse.redirect(new URL('/login?error=missing_code', req.url));
  }
  const stateCookie = req.headers
    .get('cookie')
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${STATE_COOKIE}=`))
    ?.split('=')[1];
  if (stateCookie !== state) {
    return NextResponse.redirect(new URL('/login?error=bad_state', req.url));
  }

  let profile;
  try {
    profile = await exchangeCodeForProfile({
      appId: cfg.feishuAppId,
      appSecret: cfg.feishuAppSecret,
      code,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('feishu_callback_failed', detail);
    return NextResponse.redirect(new URL('/login?error=exchange', req.url));
  }

  const userId =
    profile.tenantKey === null
      ? `feishu:${profile.openId}`
      : `feishu:${profile.tenantKey}:${profile.openId}`;

  const { token } = mintSession({
    cfg,
    userId,
    displayName: profile.displayName,
    tenantKey: profile.tenantKey,
    imBootstrap: false,
  });

  // Inform the API of the successful login so the user record / lastLoginAt
  // is refreshed before the next request lands. Best-effort; failure here
  // doesn't block the user from entering the app — they'll be auto-resolved
  // on the first authenticated API call.
  try {
    await fetch(`${process.env['QUANT_API_BASE'] ?? 'http://127.0.0.1:3001'}/api/auth/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        provider: 'feishu',
        externalId: profile.openId,
        tenantKey: profile.tenantKey,
        displayName: profile.displayName,
        email: profile.email,
        avatarUrl: profile.avatarUrl,
      }),
    });
  } catch (err) {
    console.warn('auth_sync_failed', err);
  }

  const res = NextResponse.redirect(new URL('/', req.url));
  res.cookies.set(cfg.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cfg.cookieSecure,
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SEC,
  });
  res.cookies.delete(STATE_COOKIE);
  return res;
}
