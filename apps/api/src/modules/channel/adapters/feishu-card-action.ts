/**
 * Pure helpers around Feishu card *click* events:
 *
 *   - {@link cardButtonSchema} / {@link CardButtonValue} — the JSON
 *     payload our buttons round-trip via Feishu's `value` field.
 *   - {@link parseCardAction} — narrow a `Lark.RawCardActionEvent` into
 *     `{ value, openId, chatId, messageId }` after `Lark.normalizeCardAction`.
 *   - {@link syntheticTextForAction} — translate an approved/cancelled
 *     value into the synthetic IM text that re-enters the instruction
 *     listener as a `/agent confirm=… q=…` or `/agent.confirm` line.
 *   - {@link buildDecidedCard} — render the "decided" card the adapter
 *     swaps for the original interactive card after the click.
 *
 * Pulled out of `feishu.adapter.ts` to keep that file under the 400-LoC
 * cap (CLAUDE.md §1.2). All exports are stateless: the adapter passes a
 * minimal logger surface in for warn-level diagnostics.
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';

import { buildDecidedConfirmCard, type FeishuV1Card } from './feishu-card.js';

export const cardButtonSchema = z.object({
  action: z.enum(['confirm', 'cancel']),
  correlationId: z.string().optional(),
  agentQ: z.string().optional(),
  /** Generic instruction confirm-card path: `/<cmd> confirm=1 <cmdArgs>`. */
  cmd: z.string().optional(),
  cmdArgs: z.record(z.string(), z.string()).optional(),
});
export type CardButtonValue = z.infer<typeof cardButtonSchema>;

export interface ParsedCardAction {
  readonly value: CardButtonValue;
  readonly openId: string;
  readonly chatId: string;
  readonly messageId: string;
}

export interface ActionLogger {
  warn(message: string): void;
}

export function parseCardAction(
  raw: Lark.RawCardActionEvent,
  logger: ActionLogger,
): ParsedCardAction | null {
  const normalized = Lark.normalizeCardAction(raw);
  if (normalized === null) {
    logger.warn('feishu_card_normalize_failed missing operator/context');
    return null;
  }
  // Feishu echoes the button's `value` payload back unchanged. New cards
  // emit Object values; legacy cards may have set strings — accept both.
  const rawValue = normalized.action.value;
  let v: unknown = rawValue;
  if (typeof rawValue === 'string') {
    try {
      v = JSON.parse(rawValue);
    } catch {
      v = rawValue;
    }
  }
  const result = cardButtonSchema.safeParse(v);
  if (!result.success) {
    logger.warn(`feishu_card_value_unrecognized value=${JSON.stringify(rawValue)}`);
    return null;
  }
  return {
    value: result.data,
    openId: normalized.operator.openId,
    chatId: normalized.chatId,
    messageId: normalized.messageId,
  };
}

export function syntheticTextForAction(value: CardButtonValue): string | null {
  if (value.action === 'confirm') return syntheticForConfirm(value);
  return syntheticForCancel(value);
}

function syntheticForConfirm(value: CardButtonValue): string | null {
  if (value.agentQ !== undefined) {
    return `/agent confirm=1 q="${value.agentQ.replace(/"/g, '\\"')}"`;
  }
  if (value.cmd !== undefined && value.cmd.length > 0) {
    return buildInstructionConfirmLine(value.cmd, value.cmdArgs ?? {});
  }
  if (value.correlationId !== undefined) {
    return `/agent.confirm correlationId=${value.correlationId} approve=1`;
  }
  return null;
}

function syntheticForCancel(value: CardButtonValue): string | null {
  if (value.correlationId !== undefined) {
    return `/agent.confirm correlationId=${value.correlationId} approve=0`;
  }
  // Generic cancel for the new instruction.paid_confirm card: nothing
  // to re-issue, so we surface a no-op acknowledgement that still flows
  // through the IM listener (for ACL gating + decided-card patching).
  if (value.cmd !== undefined && value.cmd.length > 0) return '/ping';
  return null;
}

function buildInstructionConfirmLine(cmd: string, args: Readonly<Record<string, string>>): string {
  const parts: string[] = [`/${cmd}`, 'confirm=1'];
  for (const [k, v] of Object.entries(args)) {
    if (k === 'confirm') continue;
    parts.push(`${k}=${quoteIfNeeded(v)}`);
  }
  return parts.join(' ');
}

function quoteIfNeeded(v: string): string {
  if (v.length === 0) return '""';
  if (/[\s"=]/u.test(v)) return `"${v.replace(/"/g, '\\"')}"`;
  return v;
}

/**
 * Build the "decided" card that replaces the original interactive
 * confirm card after the user clicks ✓ / ✗. Body is intentionally
 * minimal — the original `agentQ` / `correlationId` are not on the
 * server side after the click (they live only in the parked snapshot),
 * so we render a generic acknowledgement keyed by the action and the
 * correlation id so the user can still tell which run was decided.
 *
 * `decidedAtIso` is injected (not derived from `new Date()` here) so
 * the function stays pure / testable.
 */
export function buildDecidedCard(
  value: CardButtonValue,
  operatorOpenId: string,
  decidedAtIso: string,
): FeishuV1Card {
  const decision: 'approved' | 'cancelled' = value.action === 'confirm' ? 'approved' : 'cancelled';
  const { headerTitle, bodyMd } = decidedCardCopy(value);
  return buildDecidedConfirmCard({
    headerTitle,
    bodyMd,
    decision,
    operatorOpenId,
    decidedAtIso,
  });
}

function decidedCardCopy(value: CardButtonValue): {
  readonly headerTitle: string;
  readonly bodyMd: string;
} {
  // Generic instruction.paid_confirm flow (`{cmd, cmdArgs}`) — title /
  // body should reflect the actual command, not the agent fallback.
  if (value.cmd !== undefined && value.cmd.length > 0) {
    const argsLine = renderCmdArgs(value.cmdArgs ?? {});
    const body = argsLine.length > 0 ? `参数：\`${argsLine}\`` : '（无附加参数）';
    return { headerTitle: `❓ /${value.cmd} 需要确认`, bodyMd: body };
  }
  return decidedAgentCopy(value);
}

function decidedAgentCopy(value: CardButtonValue): {
  readonly headerTitle: string;
  readonly bodyMd: string;
} {
  // Agent flows: correlationId = mid-loop tool proposal,
  // agentQ = up-front /agent paid_confirm.
  const headerTitle =
    value.correlationId !== undefined ? '❓ Agent 工具调用 需要确认' : '❓ /agent 需要确认';
  const bodyParts: string[] = [];
  if (value.agentQ !== undefined && value.agentQ.length > 0) {
    bodyParts.push(`原始问题：\`${value.agentQ.slice(0, 200)}\``);
  }
  if (value.correlationId !== undefined && value.correlationId.length > 0) {
    bodyParts.push(`correlationId: \`${value.correlationId}\``);
  }
  const bodyMd = bodyParts.length > 0 ? bodyParts.join('\n') : '（无附加信息）';
  return { headerTitle, bodyMd };
}

function renderCmdArgs(args: Readonly<Record<string, string>>): string {
  return Object.entries(args)
    .filter(([k]) => k !== 'confirm')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
    .slice(0, 200);
}
