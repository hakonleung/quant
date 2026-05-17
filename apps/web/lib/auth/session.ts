/**
 * Server-side helpers for resolving the current user from the request
 * cookie. `AUTH_MODE=disabled` short-circuits to a synthetic `admin`
 * session so a single binary serves both auth modes.
 */

import { cookies } from 'next/headers.js';

import { getServerConfig } from '../config/config-center-next-server-getter.js';
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

/** Server component / server-side fetch helper. */
export async function getSession(): Promise<Session | null> {
  const auth = getServerConfig().auth;
  if (auth.mode === 'disabled') {
    return {
      user: { id: auth.adminUserId, name: 'admin', imBootstrap: false },
      token: null,
    };
  }
  const raw = (await cookies()).get(auth.cookieName)?.value;
  if (raw === undefined || raw.length === 0) return null;
  const payload = verifySession(raw, auth.nextauthSecret ?? '');
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
  userId: string;
  displayName: string;
  tenantKey: string | null;
  imBootstrap: boolean;
  ttlSec?: number;
}): { token: string; payload: SessionPayload } {
  const auth = getServerConfig().auth;
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSec ?? auth.jwtSessionTtlSec;
  const payload: SessionPayload = {
    userId: input.userId,
    displayName: input.displayName,
    tenantKey: input.tenantKey,
    imBootstrap: input.imBootstrap,
    iat: now,
    exp: now + ttl,
  };
  return {
    token: signSession(payload, auth.nextauthSecret ?? ''),
    payload,
  };
}
