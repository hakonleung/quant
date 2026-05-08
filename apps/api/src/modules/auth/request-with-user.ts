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
}

export interface RequestWithUser extends Request {
  user: AuthenticatedUser;
  traceId?: string;
}
