/**
 * Port for verifying a NextAuth-issued session token. In `AUTH_MODE=oauth`
 * the guard calls `verify()` on every request; in `AUTH_MODE=disabled` it
 * is never invoked.
 */

export const SESSION_VERIFIER = Symbol('SESSION_VERIFIER');

export interface SessionClaims {
  readonly userId: string;
  readonly displayName: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SessionVerifier {
  verify(token: string): Promise<SessionClaims | null>;
}
