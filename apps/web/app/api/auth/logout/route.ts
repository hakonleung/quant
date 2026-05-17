import { NextResponse } from 'next/server.js';

import { getServerConfig } from '../../../../lib/config/config-center-next-server-getter.js';

export async function POST(req: Request): Promise<Response> {
  const res = NextResponse.redirect(new URL('/login', req.url), { status: 303 });
  res.cookies.delete(getServerConfig().auth.cookieName);
  return res;
}
