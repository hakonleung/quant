/**
 * Server-side helpers for resolving the current user from the request
 * cookie. `AUTH_MODE=disabled` short-circuits to a synthetic `admin`
 * session so a single binary serves both auth modes.
 */

import { cookies } from 'next/headers.js';

import { ADMIN_USER_ID, getAuthConfig, type AuthConfig } from './config.js';
import { signSession, verifySession, type SessionPayload } from './jwt.js';

export interface Session {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly imBootstrap: boolean;
  };
  /** Raw signed JWT for downstream Bearer hops. `null` in disabled mode. */
  readonly token: string | null;
}

const ADMIN_SESSION: Session = {
  user: { id: ADMIN_USER_ID, name: 'admin', imBootstrap: false },
  token: null,
};

/** Server component / server-side fetch helper. */
export async function getSession(): Promise<Session | null> {
  const cfg = getAuthConfig();
  if (cfg.mode === 'disabled') return ADMIN_SESSION;
  const jar = await cookies();
  const raw = jar.get(cfg.cookieName)?.value;
  if (raw === undefined || raw.length === 0) return null;
  const payload = verifySession(raw, cfg.nextauthSecret);
  if (payload === null) return null;
  return {
    user: {
      id: payload.userId,
      name: payload.displayName,
      imBootstrap: payload.imBootstrap === true,
    },
    token: raw,
  };
}

/** Encodes a fresh session into a signed JWT, returns `(token, payload)`. */
export function mintSession(input: {
  cfg: AuthConfig;
  userId: string;
  displayName: string;
  tenantKey: string | null;
  imBootstrap: boolean;
  ttlSec?: number;
}): { token: string; payload: SessionPayload } {
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSec ?? 60 * 60 * 24 * 7;
  const payload: SessionPayload = {
    userId: input.userId,
    displayName: input.displayName,
    tenantKey: input.tenantKey,
    imBootstrap: input.imBootstrap,
    iat: now,
    exp: now + ttl,
  };
  return { token: signSession(payload, input.cfg.nextauthSecret), payload };
}

export const SESSION_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7;
