/**
 * Minimal HS256 JWS signer/verifier.
 *
 * Signs the same `NEXTAUTH_SECRET` that NestJS' `NextauthJwtVerifier`
 * decodes — single secret, single algorithm, two ends. Implemented with
 * Node's built-in `node:crypto` to avoid a `jose` / `next-auth`
 * dependency on the Web side.
 *
 * Server-only. Never import this from a `'use client'` module.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { getServerConfig } from '../config/config-center-next-server-getter.js';

const HEADER_B64 = base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

export interface SessionPayload {
  readonly userId: string;
  readonly displayName: string;
  readonly tenantKey?: string | null;
  readonly imBootstrap?: boolean;
  readonly iat: number;
  readonly exp: number;
}

export function signSession(payload: SessionPayload, secret: string): string {
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const data = `${HEADER_B64}.${payloadB64}`;
  const sig = createHmac('sha256', secret).update(data).digest();
  return `${data}.${base64UrlEncode(sig)}`;
}

export function verifySession(token: string, secret: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const received = decodeBase64Url(sigB64);
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(payloadB64).toString('utf8')) as SessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newSession(input: {
  userId: string;
  displayName: string;
  tenantKey?: string | null;
  imBootstrap?: boolean;
  ttlSec?: number;
}): SessionPayload {
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSec ?? getServerConfig().auth.jwtSessionTtlSec;
  return {
    userId: input.userId,
    displayName: input.displayName,
    tenantKey: input.tenantKey ?? null,
    imBootstrap: input.imBootstrap ?? false,
    iat: now,
    exp: now + ttl,
  };
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function decodeBase64Url(s: string): Buffer {
  const normalised = s.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = normalised.padEnd(normalised.length + ((4 - (normalised.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}
