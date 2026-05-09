/**
 * `/usr` — print the caller's resolved identity + permissions.
 *
 * Renders the resolved internal `userId`, the inbound channel + sender
 * when the call arrived via IM, and — when the IM sender was promoted
 * onto the synthetic `admin` user via `AUTH_ADMIN_USER_IDS` — the
 * original prefixed IM id alongside the mapped admin id, so the user
 * can confirm the promotion took effect without grepping logs.
 */

import { Inject, Injectable } from '@nestjs/common';
import { instructionId, okResult, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import { AuthConfig } from '../../auth/config/auth.config.js';
import type { InstructionCtx } from '../instruction.port.js';
import { InstructionRegistrarBase } from '../instruction.provider.js';
import { InstructionRegistry } from '../instruction.registry.js';
import type { InstructionSpec } from '../instruction.types.js';

const argsSchema = z.object({}).strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class UsrHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('usr'),
    summary: "Show the caller's resolved userId, source, and admin status.",
    summaryCn: '显示当前用户 ID 与权限',
    group: 'system',
    argsSchema,
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(AuthConfig) private readonly authCfg: AuthConfig,
  ) {
    super(registry);
  }

  execute(_args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const isAdmin = ctx.userId === this.authCfg.adminUserId;
    const lines: string[] = [
      `user_id  : ${ctx.userId}`,
      `role     : ${isAdmin ? 'admin' : 'user'}`,
      `source   : ${ctx.source}`,
    ];
    if (ctx.channelId !== undefined) {
      lines.push(`channel  : ${ctx.channelId}`);
    }
    if (ctx.sender !== undefined) {
      lines.push(`im_id    : ${ctx.sender}`);
    }
    // `originalUserId` is set only when AUTH_ADMIN_USER_IDS promoted us
    // (see AuthService.adminUser). Surface it so admins can confirm the
    // env knob is in effect without grepping logs.
    if (ctx.originalUserId !== undefined) {
      lines.push(`mapped_from: ${ctx.originalUserId} (AUTH_ADMIN_USER_IDS)`);
    }
    if (ctx.imBootstrap === true) {
      lines.push('bootstrap: true (no Web login yet)');
    }
    return Promise.resolve(okResult(lines.join('\n')));
  }
}
