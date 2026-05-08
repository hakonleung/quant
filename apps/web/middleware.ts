/**
 * Edge middleware — gates the workbench shell so unauthenticated users
 * are bounced to /login. Static assets, the auth routes themselves, and
 * the login page itself are exempt.
 *
 * In `AUTH_MODE=disabled` mode this middleware short-circuits to a no-op
 * so local-LAN deployments keep working without any login UI.
 */

import { NextResponse, type NextRequest } from 'next/server.js';

const COOKIE_NAME = 'next-auth.session-token';
const PUBLIC_PREFIXES = ['/login', '/api/auth', '/_next', '/favicon', '/static'] as const;

export function middleware(req: NextRequest): NextResponse {
  const mode = process.env['AUTH_MODE'] ?? process.env['NEXT_PUBLIC_AUTH_MODE'] ?? 'disabled';
  if (mode !== 'oauth') return NextResponse.next();
  const path = req.nextUrl.pathname;
  for (const p of PUBLIC_PREFIXES) {
    if (path === p || path.startsWith(`${p}/`)) return NextResponse.next();
  }
  const cookie = req.cookies.get(COOKIE_NAME);
  if (cookie === undefined || cookie.value.length === 0) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
