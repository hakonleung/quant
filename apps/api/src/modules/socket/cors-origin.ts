/**
 * Origin matcher used by both the HTTP CORS layer (`main.ts`) and the
 * Socket.IO gateway. Allows:
 *
 *   - Requests with no `Origin` (curl / health checks).
 *   - Same-host different-port: if the request targets `127.0.0.1:3001`
 *     and the browser is on `127.0.0.1:3000`, accept. Useful for the
 *     Next dev server (port 3000/3100) reaching the Nest API (3001).
 *   - Loopback hostnames: `localhost`, `127.0.0.1` regardless of port.
 *   - Anything in `EXTRA_ALLOWED_ORIGINS` (comma-separated env, exact
 *     origin strings) — escape hatch for a deliberate cross-host setup.
 *
 * Implementation note: the function returns the boolean callback Express
 * + socket.io expect; we keep a thin parser cache to avoid re-running
 * the URL constructor on every request.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const EXTRA_ALLOWED = (process.env['QUANT_ALLOWED_ORIGINS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const parseCache = new Map<string, URL | null>();

function parseOrigin(origin: string): URL | null {
  if (parseCache.has(origin)) return parseCache.get(origin) ?? null;
  let parsed: URL | null = null;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = null;
  }
  parseCache.set(origin, parsed);
  return parsed;
}

export function isOriginAllowed(origin: string | undefined, hostHeader?: string): boolean {
  if (origin === undefined || origin === '') return true;
  if (EXTRA_ALLOWED.includes(origin)) return true;
  const parsed = parseOrigin(origin);
  if (parsed === null) return false;
  if (LOOPBACK_HOSTS.has(parsed.hostname)) return true;
  if (hostHeader !== undefined && hostHeader.length > 0) {
    // Same hostname, different port (Next on 3000, Nest on 3001).
    const reqHost = hostHeader.split(':')[0] ?? '';
    if (reqHost.length > 0 && reqHost === parsed.hostname) return true;
  }
  return false;
}

/** Express-style CORS callback (`(origin, cb) => void`). */
export type OriginCallback = (err: Error | null, allow?: boolean) => void;

export function corsOriginCallback(origin: string | undefined, cb: OriginCallback): void {
  if (isOriginAllowed(origin)) cb(null, true);
  else cb(new Error(`origin not allowed: ${origin ?? '<none>'}`));
}
