/**
 * GET /api/auth/feishu/start
 *
 * Generates an opaque CSRF `state`, stores it in a short-lived cookie,
 * and redirects the browser to Feishu's authorize URL. The callback
 * route verifies the state on return.
 */

import { randomBytes } from 'node:crypto';

import { NextResponse } from 'next/server.js';

import { getAuthConfig } from '../../../../../lib/auth/config.js';
import { buildAuthorizeUrl } from '../../../../../lib/auth/feishu-provider.js';

const STATE_COOKIE = 'next-auth.feishu-state';

export async function GET(req: Request): Promise<Response> {
  const cfg = getAuthConfig();
  if (cfg.mode === 'disabled') {
    return NextResponse.redirect(new URL('/', req.url));
  }
  const state = randomBytes(16).toString('hex');
  const redirectUri = `${cfg.publicBaseUrl}/api/auth/callback/feishu`;
  const authorize = buildAuthorizeUrl({
    appId: cfg.feishuAppId,
    redirectUri,
    state,
  });
  const res = NextResponse.redirect(authorize);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cfg.cookieSecure,
    path: '/',
    maxAge: 600,
  });
  return res;
}
