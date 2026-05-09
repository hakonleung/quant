/**
 * Request shape after `AuthGuard` has run. The guard always populates
 * `req.user`; in `AUTH_MODE=disabled` it injects the synthetic admin
 * user so downstream code can ignore the auth-mode split.
 */

import type { Request } from 'express';

export type AuthSource = 'oauth' | 'env' | 'im';

export interface AuthenticatedUser {
  readonly id: string;
  readonly displayName: string;
  readonly source: AuthSource;
  /** True when the user has only ever been seen via IM, never via Web OAuth. */
  readonly imBootstrap: boolean;
  /**
   * Pre-mapping userId, set only when the caller's natural id was promoted
   * onto the synthetic admin user via `AUTH_ADMIN_USER_IDS`. Lets the
   * `/usr` instruction tell the user "you're admin, but your real id is X"
   * without leaking implementation details to non-admin paths.
   */
  readonly originalUserId?: string;
}

export interface RequestWithUser extends Request {
  user: AuthenticatedUser;
  traceId?: string;
}
