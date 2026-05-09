import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { AuthGuard } from '../../../src/modules/auth/auth.guard.js';
import type { AuthService } from '../../../src/modules/auth/auth.service.js';
import type { AuthConfigShape } from '../../../src/modules/auth/config/auth.config.js';
import type { AuthenticatedUser } from '../../../src/modules/auth/request-with-user.js';

function ctxFor(req: Partial<Request>): ExecutionContext {
  const httpCtx = {
    getRequest: <T>() => req as unknown as T,
  };
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => httpCtx,
  } as unknown as ExecutionContext;
}

const adminUser: AuthenticatedUser = {
  id: 'admin',
  displayName: 'admin',
  source: 'env',
  imBootstrap: false,
};

const oauthUser: AuthenticatedUser = {
  id: 'feishu:ou_xyz',
  displayName: 'Alice',
  source: 'oauth',
  imBootstrap: false,
};

function buildGuard(input: { cfg: AuthConfigShape; resolved: AuthenticatedUser | null }): {
  guard: AuthGuard;
  calls: Array<Partial<Request>>;
} {
  const calls: Array<Partial<Request>> = [];
  const auth = {
    resolveFromHttp: (req: Request) => {
      calls.push(req);
      return Promise.resolve(input.resolved);
    },
  } as unknown as AuthService;
  const reflector = new Reflector();
  return { guard: new AuthGuard(input.cfg, auth, reflector), calls };
}

describe('AuthGuard', () => {
  it('admits the synthetic admin user under AUTH_MODE=disabled', async () => {
    const cfg: AuthConfigShape = {
      mode: 'disabled',
      nextauthSecret: null,
      dataRoot: '/tmp',
      adminUserId: 'admin',
      adminUserIds: new Set<string>(),
    };
    const { guard } = buildGuard({ cfg, resolved: adminUser });
    const req: Partial<Request> = { path: '/api/anything' };
    expect(await guard.canActivate(ctxFor(req))).toBe(true);
    expect((req as Request & { user?: AuthenticatedUser }).user).toEqual(adminUser);
  });

  it('admits an oauth user when resolveFromHttp returns claims', async () => {
    const cfg: AuthConfigShape = {
      mode: 'oauth',
      nextauthSecret: 'shh',
      dataRoot: '/tmp',
      adminUserId: 'admin',
      adminUserIds: new Set<string>(),
    };
    const { guard } = buildGuard({ cfg, resolved: oauthUser });
    const req: Partial<Request> = {
      path: '/api/ledger',
      header: () => 'Bearer abc',
    } as unknown as Partial<Request>;
    expect(await guard.canActivate(ctxFor(req))).toBe(true);
    expect((req as Request & { user?: AuthenticatedUser }).user).toEqual(oauthUser);
  });

  it('rejects with 401 when no session resolves under oauth mode', async () => {
    const cfg: AuthConfigShape = {
      mode: 'oauth',
      nextauthSecret: 'shh',
      dataRoot: '/tmp',
      adminUserId: 'admin',
      adminUserIds: new Set<string>(),
    };
    const { guard } = buildGuard({ cfg, resolved: null });
    const req: Partial<Request> = { path: '/api/ledger' };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
