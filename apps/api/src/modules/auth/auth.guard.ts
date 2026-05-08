/**
 * Global auth guard.
 *
 *   AUTH_MODE=disabled → inject the synthetic admin user, never reject.
 *   AUTH_MODE=oauth    → require a verified NextAuth Bearer/cookie token.
 *
 * Health checks pass through unauthenticated so liveness probes don't
 * need credentials.
 */

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthService } from './auth.service.js';
import { AUTH_CONFIG, type AuthConfigShape } from './config/auth.config.js';
import { ALLOW_ANON_KEY } from './public.decorator.js';
import type { RequestWithUser } from './request-with-user.js';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfigShape,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const httpType = ctx.getType<'http' | 'rpc' | 'ws'>();
    if (httpType !== 'http') return true;
    const allowAnon = this.reflector.getAllAndOverride<boolean>(ALLOW_ANON_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (allowAnon === true) return true;
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    const user = await this.auth.resolveFromHttp(req);
    if (user === null) {
      this.logger.warn(`auth_reject path=${req.path} mode=${this.cfg.mode}`);
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHENTICATED',
        message: 'login required',
        details: {},
      });
    }
    req.user = user;
    return true;
  }
}
