/**
 * Verifies HS256 JWS session tokens minted by the Web BFF (or NextAuth's
 * `next-auth/jwt` raw-mode export). Implementation uses Node's built-in
 * `node:crypto` HMAC; no extra dependencies.
 *
 * Token shape (compact JWS):
 *   `${base64url(header)}.${base64url(payload)}.${base64url(sig)}`
 *
 * Required claims:
 *   - `userId` (or `sub`) — canonical internal id (`feishu:ou_xxx`)
 *   - `exp`            — UNIX seconds; tokens past `exp` are rejected
 *   - `iat`            — UNIX seconds; informational
 *   - `displayName` (or `name`) — optional, falls back to userId
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

import type { SessionClaims, SessionVerifier } from '../ports/session-verifier.port.js';

@Injectable()
export class NextauthJwtVerifier implements SessionVerifier {
  private readonly logger = new Logger(NextauthJwtVerifier.name);

  constructor(private readonly secret: string | null) {}

  async verify(token: string): Promise<SessionClaims | null> {
    return Promise.resolve(this.verifySync(token));
  }

  private verifySync(token: string): SessionClaims | null {
    if (this.secret === null) return null;
    if (token.length === 0) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    let header: { alg?: string; typ?: string };
    try {
      header = JSON.parse(decodeBase64Url(headerB64).toString('utf8')) as {
        alg?: string;
        typ?: string;
      };
    } catch {
      return null;
    }
    if (header.alg !== 'HS256') {
      this.logger.warn(`session_verify_unsupported_alg=${String(header.alg)}`);
      return null;
    }

    const expected = createHmac('sha256', this.secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    let received: Buffer;
    try {
      received = decodeBase64Url(sigB64);
    } catch {
      return null;
    }
    if (received.length !== expected.length || !timingSafeEqual(expected, received)) {
      this.logger.warn('session_verify_bad_sig');
      return null;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(decodeBase64Url(payloadB64).toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
    const userId = pickString(payload, ['userId', 'sub']);
    if (userId === null) return null;
    const displayName = pickString(payload, ['displayName', 'name']) ?? userId;
    const issuedAt =
      typeof payload['iat'] === 'number' ? payload['iat'] : Math.floor(Date.now() / 1000);
    const expiresAt =
      typeof payload['exp'] === 'number' ? payload['exp'] : issuedAt + 60 * 60 * 24;
    const nowSec = Math.floor(Date.now() / 1000);
    if (expiresAt < nowSec) {
      this.logger.warn('session_verify_expired');
      return null;
    }
    return { userId, displayName, issuedAt, expiresAt };
  }
}

function decodeBase64Url(s: string): Buffer {
  const normalised = s.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = normalised.padEnd(normalised.length + ((4 - (normalised.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function pickString(payload: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
