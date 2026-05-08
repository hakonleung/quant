import { NextResponse } from 'next/server.js';

import { getAuthConfig } from '../../../../lib/auth/config.js';

export async function POST(req: Request): Promise<Response> {
  const cfg = getAuthConfig();
  const res = NextResponse.redirect(new URL('/login', req.url), { status: 303 });
  res.cookies.delete(cfg.cookieName);
  return res;
}
