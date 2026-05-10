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
    const identityRows: ReadonlyArray<readonly [string, string]> = [
      ['user_id', ctx.userId],
      ['role', isAdmin ? 'admin' : 'user'],
      ['source', ctx.source],
      ...(ctx.channelId !== undefined ? [['channel', ctx.channelId] as const] : []),
      ...(ctx.sender !== undefined ? [['im_id', ctx.sender] as const] : []),
      ...(ctx.originalUserId !== undefined
        ? [['mapped_from', `${ctx.originalUserId} (AUTH_ADMIN_USER_IDS)`] as const]
        : []),
      ...(ctx.imBootstrap === true ? [['bootstrap', 'true (no Web login yet)'] as const] : []),
    ];
    const sections = [renderKvTable(identityRows), await this.ledgerSection(ctx.userId)];
    return okResult(sections.join('\n\n'));
  }

  private async ledgerSection(userId: string): Promise<string> {
    const now = this.clock.now();
    const startOfTodayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const startOfMonthMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const [today, month, total] = await Promise.all([
      this.ledger.summarize(userId, new Date(startOfTodayMs)),
      this.ledger.summarize(userId, new Date(startOfMonthMs)),
      this.ledger.summarize(userId, null),
    ]);
    if (total.callCount === 0) {
      return '【LLM 消耗】\n```\n(no calls yet)\n```';
    }
    const spendRows: ReadonlyArray<readonly [string, string, string, string]> = [
      ['scope', 'cny', 'calls', 'tokens'],
      ['today', `¥ ${today.totalCnyCost.toFixed(4)}`, String(today.callCount), String(today.totalUsage.total)],
      ['month', `¥ ${month.totalCnyCost.toFixed(4)}`, String(month.callCount), String(month.totalUsage.total)],
      ['total', `¥ ${total.totalCnyCost.toFixed(4)}`, String(total.callCount), String(total.totalUsage.total)],
    ];
    const out = [`【LLM 消耗】`, render4ColTable(spendRows)];
    const scopes = Array.from(total.byScope.entries()).sort((a, b) => b[1].cnyCost - a[1].cnyCost);
    if (scopes.length > 0) {
      const byScopeRows: ReadonlyArray<readonly [string, string, string]> = [
        ['scope', 'cny', 'calls'],
        ...scopes.map(
          ([scope, agg]) =>
            [scope, `¥ ${agg.cnyCost.toFixed(4)}`, String(agg.callCount)] as const,
        ),
      ];
      out.push(`【按 scope 拆分】`, render3ColTable(byScopeRows));
    }
    return out.join('\n');
  }
}

// ── pure render helpers ──────────────────────────────────────────────────
//
// Code-fenced fixed-width tables — same approach as `format-stock-table.ts`
// and the help handler. lark_md collapses multi-space runs unless the
// block is fenced, so without ``` the columns drift visibly.

function renderKvTable(rows: ReadonlyArray<readonly [string, string]>): string {
  const w0 = maxWidth(rows.map((r) => r[0]));
  const w1 = maxWidth(rows.map((r) => r[1]));
  const lines = rows.map(([k, v]) => `${pad(k, w0, 'left')}  ${pad(v, w1, 'left')}`);
  return ['```', ...lines, '```'].join('\n');
}

function render4ColTable(
  rows: ReadonlyArray<readonly [string, string, string, string]>,
): string {
  const widths: [number, number, number, number] = [
    maxWidth(rows.map((r) => r[0])),
    maxWidth(rows.map((r) => r[1])),
    maxWidth(rows.map((r) => r[2])),
    maxWidth(rows.map((r) => r[3])),
  ];
  const fmt = (r: readonly [string, string, string, string]): string =>
    `${pad(r[0], widths[0], 'left')}  ${pad(r[1], widths[1], 'right')}  ${pad(r[2], widths[2], 'right')}  ${pad(r[3], widths[3], 'right')}`;
  const sep = `${'─'.repeat(widths[0])}  ${'─'.repeat(widths[1])}  ${'─'.repeat(widths[2])}  ${'─'.repeat(widths[3])}`;
  const header = rows[0];
  const body = rows.slice(1);
  if (header === undefined) return '```\n(no data)\n```';
  return ['```', fmt(header), sep, ...body.map(fmt), '```'].join('\n');
}

function render3ColTable(rows: ReadonlyArray<readonly [string, string, string]>): string {
  const widths: [number, number, number] = [
    maxWidth(rows.map((r) => r[0])),
    maxWidth(rows.map((r) => r[1])),
    maxWidth(rows.map((r) => r[2])),
  ];
  const fmt = (r: readonly [string, string, string]): string =>
    `${pad(r[0], widths[0], 'left')}  ${pad(r[1], widths[1], 'right')}  ${pad(r[2], widths[2], 'right')}`;
  const sep = `${'─'.repeat(widths[0])}  ${'─'.repeat(widths[1])}  ${'─'.repeat(widths[2])}`;
  const header = rows[0];
  const body = rows.slice(1);
  if (header === undefined) return '```\n(no data)\n```';
  return ['```', fmt(header), sep, ...body.map(fmt), '```'].join('\n');
}

function maxWidth(strs: readonly string[]): number {
  let m = 0;
  for (const s of strs) {
    const w = displayWidth(s);
    if (w > m) m = w;
  }
  return m;
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

function pad(s: string, target: number, side: 'left' | 'right'): string {
  const w = displayWidth(s);
  if (w >= target) return s;
  const fill = ' '.repeat(target - w);
  return side === 'left' ? s + fill : fill + s;
}
