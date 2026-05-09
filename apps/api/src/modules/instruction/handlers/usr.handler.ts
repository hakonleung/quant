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
import { CLOCK, type Clock } from '../../../common/clock.js';
import { UserLlmLedgerStore } from '../../llm/ledger/user-llm-ledger.store.js';
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
    summary: "Show the caller's resolved userId, source, admin status, and LLM spend totals.",
    summaryCn: '显示当前用户 ID、权限与 LLM 累计消耗',
    group: 'system',
    argsSchema,
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(AuthConfig) private readonly authCfg: AuthConfig,
    @Inject(UserLlmLedgerStore) private readonly ledger: UserLlmLedgerStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(registry);
  }

  async execute(_args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
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
    if (ctx.originalUserId !== undefined) {
      lines.push(`mapped_from: ${ctx.originalUserId} (AUTH_ADMIN_USER_IDS)`);
    }
    if (ctx.imBootstrap === true) {
      lines.push('bootstrap: true (no Web login yet)');
    }
    lines.push('');
    lines.push(...(await this.ledgerLines(ctx.userId)));
    return okResult(lines.join('\n'));
  }

  private async ledgerLines(userId: string): Promise<readonly string[]> {
    const now = this.clock.now();
    const startOfTodayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const startOfMonthMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const [today, month, total] = await Promise.all([
      this.ledger.summarize(userId, new Date(startOfTodayMs)),
      this.ledger.summarize(userId, new Date(startOfMonthMs)),
      this.ledger.summarize(userId, null),
    ]);
    if (total.callCount === 0) {
      return ['llm spend: (no calls yet)'];
    }
    const lines: string[] = [
      'llm spend:',
      `  today  : ¥ ${today.totalCnyCost.toFixed(4)}  (${String(today.callCount)} calls, ${String(today.totalUsage.total)} tokens)`,
      `  month  : ¥ ${month.totalCnyCost.toFixed(4)}  (${String(month.callCount)} calls, ${String(month.totalUsage.total)} tokens)`,
      `  total  : ¥ ${total.totalCnyCost.toFixed(4)}  (${String(total.callCount)} calls, ${String(total.totalUsage.total)} tokens)`,
    ];
    const scopes = Array.from(total.byScope.entries()).sort((a, b) => b[1].cnyCost - a[1].cnyCost);
    if (scopes.length > 0) {
      lines.push('  by scope (total):');
      for (const [scope, agg] of scopes) {
        lines.push(
          `    ${scope.padEnd(8)}: ¥ ${agg.cnyCost.toFixed(4)}  ${String(agg.callCount)} calls`,
        );
      }
    }
    return lines;
  }
}
