import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedUser, RequestWithUser } from './request-with-user.js';

/**
 * Pulls the authenticated user out of the request. `AuthGuard` is global
 * and always populates `req.user`, so this decorator is total — it never
 * returns undefined when the route is reachable.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    return req.user;
  },
);
