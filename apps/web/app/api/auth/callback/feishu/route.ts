/**
 * GET /api/auth/callback/feishu?code=…&state=…
 *
 * Verifies the CSRF `state` cookie, exchanges the auth code for a Feishu
 * user_access_token (via app_access_token), reads the user profile, and
 * mints our internal session JWT into an httpOnly cookie. Then notifies
 * the NestJS API so the user record's `lastLoginAt` updates and the
 * imBootstrap state lifts.
 */

import { NextRequest, NextResponse } from 'next/server.js';

import { getServerConfig } from '../../../../../lib/config/config-center-next-server-getter.js';
import { exchangeCodeForProfile } from '../../../../../lib/auth/feishu-provider.js';
import { mintSession } from '../../../../../lib/auth/session.js';

const STATE_COOKIE = 'next-auth.feishu-state';

export async function GET(req: NextRequest): Promise<Response> {
  const { auth, channel } = getServerConfig();
  if (auth.mode === 'disabled' || channel.feishu === null) {
    return NextResponse.redirect(new URL('/', req.url));
  }
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (code === null || state === null) {
    return NextResponse.redirect(new URL('/login?error=missing_code', req.url));
  }
  // NextRequest decodes the cookie correctly even when the value contains
  // `=`/`;`, and won't be tripped up by adjacent cookies whose names share
  // the `next-auth.` prefix. Manual cookie-header parsing was the source
  // of intermittent `bad_state` redirects.
  const stateCookie = req.cookies.get(STATE_COOKIE)?.value;
  if (stateCookie === undefined || stateCookie.length === 0) {
    console.warn('feishu_callback_state_cookie_missing host=%s', url.host);
    return NextResponse.redirect(new URL('/login?error=bad_state', req.url));
  }
  if (stateCookie !== state) {
    console.warn('feishu_callback_state_mismatch');
    return NextResponse.redirect(new URL('/login?error=bad_state', req.url));
  }

  let profile;
  try {
    profile = await exchangeCodeForProfile({
      appId: channel.feishu.appId,
      appSecret: channel.feishu.appSecret,
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
  res.cookies.set(auth.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: auth.nextauthUrl.startsWith('https://'),
    path: '/',
    maxAge: auth.jwtSessionTtlSec,
  });
  res.cookies.delete(STATE_COOKIE);
  return res;
}
