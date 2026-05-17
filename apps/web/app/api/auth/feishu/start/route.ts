/**
 * GET /api/auth/feishu/start
 *
 * Generates an opaque CSRF `state`, stores it in a short-lived cookie,
 * and redirects the browser to Feishu's authorize URL. The callback
 * route verifies the state on return.
 *
 * The redirect URI is built from the **incoming request's origin** rather
 * than `NEXTAUTH_URL` so the cookie's host scope and the post-OAuth
 * callback request always live on the same host (the most common cause
 * of `bad_state` is starting on `localhost` while NEXTAUTH_URL points to
 * `127.0.0.1` — Feishu redirects to a host the cookie was never set on).
 */

import { randomBytes } from 'node:crypto';

import { NextResponse } from 'next/server.js';

import { getServerConfig } from '../../../../../lib/config/config-center-next-server-getter.js';
import { buildAuthorizeUrl } from '../../../../../lib/auth/feishu-provider.js';

const STATE_COOKIE = 'next-auth.feishu-state';

export async function GET(req: Request): Promise<Response> {
  const { auth, channel } = getServerConfig();
  if (auth.mode === 'disabled' || channel.feishu === null) {
    return NextResponse.redirect(new URL('/', req.url));
  }
  const state = randomBytes(16).toString('hex');
  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/auth/callback/feishu`;
  const authorize = buildAuthorizeUrl({
    appId: channel.feishu.appId,
    redirectUri,
    state,
  });
  const res = NextResponse.redirect(authorize);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    // Mirror the request's scheme rather than NEXTAUTH_URL so a
    // misconfigured base URL can't drop the state cookie on a plain
    // HTTP loopback dev session.
    secure: origin.startsWith('https://'),
    path: '/',
    maxAge: 600,
  });
  return res;
}
