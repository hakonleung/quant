/**
 * Auth surface for the Web BFF.
 *
 *   POST /api/auth/sync   — called by the OAuth callback after the Web
 *                           side mints the session. Refreshes the user
 *                           record's `lastLoginAt` and lifts the
 *                           `imBootstrap` flag if it was set.
 *
 *   GET  /api/auth/me     — returns the resolved AuthenticatedUser; useful
 *                           for the FE's user-chip and for debugging.
 */

import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './current-user.decorator.js';
import type { AuthenticatedUser } from './request-with-user.js';

const SyncBodySchema = z
  .object({
    provider: z.literal('feishu'),
    externalId: z.string().min(1),
    tenantKey: z.string().nullable(),
    displayName: z.string().min(1),
    email: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  })
  .strict();
type SyncBody = z.infer<typeof SyncBodySchema>;

const syncPipe = new ZodValidationPipe(SyncBodySchema);

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  @Post('sync')
  async sync(
    @CurrentUser() user: AuthenticatedUser,
    @Body(syncPipe) body: SyncBody,
  ): Promise<AuthenticatedUser> {
    await this.auth.touchWebLogin({
      id: user.id,
      provider: body.provider,
      externalId: body.externalId,
      tenantKey: body.tenantKey,
      displayName: body.displayName,
      email: body.email,
      avatarUrl: body.avatarUrl,
    });
    return { ...user, imBootstrap: false };
  }
}
