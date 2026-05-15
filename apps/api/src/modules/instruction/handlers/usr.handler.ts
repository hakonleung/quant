/**
 * `/usr` — print the caller's resolved identity + LLM token usage.
 *
 * Renders the resolved internal `userId`, the inbound channel + sender
 * when the call arrived via IM, and — when the IM sender was promoted
 * onto the synthetic `admin` user via `AUTH_ADMIN_USER_IDS` — the
 * original prefixed IM id alongside the mapped admin id, so the user
 * can confirm the promotion took effect without grepping logs.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  UsrArgsSchema,
  instructionId,
  okResultWithMeta,
  type InstructionResult,
} from '@quant/shared';
import type { z } from 'zod';

import { AuthConfig } from '../../auth/config/auth.config.js';
import { CLOCK, type Clock } from '../../../common/clock.js';
import {
  UserLlmLedgerStore,
  type UserLlmLedgerSummary,
} from '../../llm/ledger/user-llm-ledger.store.js';
import type { InstructionCtx } from '../instruction.port.js';
import { InstructionRegistrarBase } from '../instruction.provider.js';
import { InstructionRegistry } from '../instruction.registry.js';
import type { InstructionSpec } from '../instruction.types.js';

const argsSchema = UsrArgsSchema;
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class UsrHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('usr'),
    summary: "Show the caller's resolved userId, source, admin status, and LLM token usage.",
    summaryCn: '显示当前用户 ID、权限与 LLM 使用情况',
    group: 'system',
    argsSchema,
    imAliases: ['我的', '账号', '我'],
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
    const identityRows = buildIdentityRows(ctx, this.authCfg.adminUserId);
    const ledgerData = await this.collectLedger(ctx.userId);
    const text = [renderKvTable(identityRows), this.ledgerTextSection(ledgerData)].join('\n\n');
    const tableSections: Record<string, unknown>[] = [
      identityTableSection(identityRows),
      ...ledgerTableSections(ledgerData),
    ];
    return okResultWithMeta(text, { tableSections });
  }

  private async collectLedger(userId: string): Promise<LedgerSnapshot | null> {
    const now = this.clock.now();
    const startOfTodayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const startOfMonthMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const [today, month, total] = await Promise.all([
      this.ledger.summarize(userId, new Date(startOfTodayMs)),
      this.ledger.summarize(userId, new Date(startOfMonthMs)),
      this.ledger.summarize(userId, null),
    ]);
    if (total.callCount === 0) return null;
    const byScope = Array.from(total.byScope.entries()).sort(
      (a, b) => b[1].usage.total - a[1].usage.total,
    );
    const byModel = Array.from(total.byModel.entries()).sort(
      (a, b) => b[1].usage.total - a[1].usage.total,
    );
    return { today, month, total, byScope, byModel };
  }

  private ledgerTextSection(data: LedgerSnapshot | null): string {
    if (data === null) return '【LLM 使用】\n```\n(no calls yet)\n```';
    const spendRows: readonly (readonly [string, string, string, string])[] = [
      ['scope', 'calls', 'in', 'out'],
      ...spendRow('today', data.today),
      ...spendRow('month', data.month),
      ...spendRow('total', data.total),
    ];
    const out = [`【LLM 使用】`, render4ColTable(spendRows)];
    if (data.byScope.length > 0) {
      out.push(`【按 scope 拆分】`, render3ColTable(scopeOrModelRows('scope', data.byScope)));
    }
    if (data.byModel.length > 0) {
      out.push(`【按 model 拆分】`, render3ColTable(scopeOrModelRows('model', data.byModel)));
    }
    return out.join('\n');
  }
}

type ScopeKey = Parameters<UserLlmLedgerSummary['byScope']['get']>[0];
type ScopeAgg = NonNullable<ReturnType<UserLlmLedgerSummary['byScope']['get']>>;
interface LedgerSnapshot {
  readonly today: UserLlmLedgerSummary;
  readonly month: UserLlmLedgerSummary;
  readonly total: UserLlmLedgerSummary;
  readonly byScope: readonly (readonly [ScopeKey, ScopeAgg])[];
  readonly byModel: readonly (readonly [string, ScopeAgg])[];
}

function spendRow(
  label: string,
  s: UserLlmLedgerSummary,
): readonly (readonly [string, string, string, string])[] {
  return [
    [
      label,
      String(s.callCount),
      String(s.totalUsage.input),
      String(s.totalUsage.output),
    ],
  ];
}

function spendCells(s: UserLlmLedgerSummary): Record<string, string> {
  return {
    calls: String(s.callCount),
    in: String(s.totalUsage.input),
    out: String(s.totalUsage.output),
  };
}

function scopeOrModelRows(
  header: 'scope' | 'model',
  agg: readonly (readonly [string, ScopeAgg])[],
): readonly (readonly [string, string, string])[] {
  return [
    [header, 'calls', 'tokens'],
    ...agg.map(([k, a]) => [k, String(a.callCount), String(a.usage.total)] as const),
  ];
}

function buildIdentityRows(
  ctx: InstructionCtx,
  adminUserId: string,
): readonly (readonly [string, string])[] {
  const isAdmin = ctx.userId === adminUserId;
  return [
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
}

function identityTableSection(
  identityRows: readonly (readonly [string, string])[],
): Record<string, unknown> {
  return {
    title: '身份',
    columns: [
      { name: 'k', displayName: 'key', horizontalAlign: 'left', width: '110px' },
      { name: 'v', displayName: 'value', horizontalAlign: 'left' },
    ],
    rows: identityRows.map(([k, v]) => ({ k, v })),
  };
}

function ledgerTableSections(data: LedgerSnapshot | null): Record<string, unknown>[] {
  if (data === null) {
    return [
      {
        title: 'LLM 使用',
        columns: [{ name: 'note', displayName: '', horizontalAlign: 'left' }],
        rows: [{ note: '(no calls yet)' }],
      },
    ];
  }
  const sections: Record<string, unknown>[] = [
    {
      title: 'LLM 使用',
      columns: [
        { name: 'scope', displayName: 'scope', horizontalAlign: 'left', width: '90px' },
        { name: 'calls', displayName: 'calls', horizontalAlign: 'right', width: '80px' },
        { name: 'in', displayName: 'in', horizontalAlign: 'right', width: '90px' },
        { name: 'out', displayName: 'out', horizontalAlign: 'right', width: '90px' },
      ],
      rows: [
        { scope: 'today', ...spendCells(data.today) },
        { scope: 'month', ...spendCells(data.month) },
        { scope: 'total', ...spendCells(data.total) },
      ],
    },
  ];
  if (data.byScope.length > 0) {
    sections.push({
      title: '按 scope 拆分',
      columns: [
        { name: 'scope', displayName: 'scope', horizontalAlign: 'left', width: '160px' },
        { name: 'calls', displayName: 'calls', horizontalAlign: 'right', width: '90px' },
        { name: 'tokens', displayName: 'tokens', horizontalAlign: 'right', width: '110px' },
      ],
      rows: data.byScope.map(([scope, a]) => ({
        scope,
        calls: String(a.callCount),
        tokens: String(a.usage.total),
      })),
    });
  }
  if (data.byModel.length > 0) {
    sections.push({
      title: '按 model 拆分',
      columns: [
        { name: 'model', displayName: 'model', horizontalAlign: 'left', width: '160px' },
        { name: 'calls', displayName: 'calls', horizontalAlign: 'right', width: '90px' },
        { name: 'tokens', displayName: 'tokens', horizontalAlign: 'right', width: '110px' },
      ],
      rows: data.byModel.map(([model, a]) => ({
        model,
        calls: String(a.callCount),
        tokens: String(a.usage.total),
      })),
    });
  }
  return sections;
}


// ── pure render helpers ──────────────────────────────────────────────────
//
// Code-fenced fixed-width tables — same approach as `format-stock-table.ts`
// and the help handler. lark_md collapses multi-space runs unless the
// block is fenced, so without ``` the columns drift visibly.

function renderKvTable(rows: readonly (readonly [string, string])[]): string {
  const w0 = maxWidth(rows.map((r) => r[0]));
  const w1 = maxWidth(rows.map((r) => r[1]));
  const lines = rows.map(([k, v]) => `${pad(k, w0, 'left')}  ${pad(v, w1, 'left')}`);
  return ['```', ...lines, '```'].join('\n');
}

function render4ColTable(
  rows: readonly (readonly [string, string, string, string])[],
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

function render3ColTable(rows: readonly (readonly [string, string, string])[]): string {
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
