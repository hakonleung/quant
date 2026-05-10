/**
 * Feishu cards owned by the `/agent` flow:
 *
 *   - {@link buildAgentPaidConfirmCard} — the up-front
 *     "/agent costs credits, confirm?" card with ✓/✗ buttons.
 *   - {@link buildAgentToolProposalCard} — mid-loop "the agent wants
 *     to call these tools, confirm?" card.
 *   - {@link buildDecidedConfirmCard} — replacement card pushed back
 *     after the user clicks ✓/✗ so the chat shows the recorded choice
 *     instead of stale live buttons.
 *
 * Kept in a separate module from `feishu-card.ts` to honour the 400-LoC
 * file budget (CLAUDE.md §1.2) — these cards share the agent-flow
 * concern, are emitted from one consumer (the agent service / channel
 * adapter), and don't intersect with the regular reply / async / watch
 * cards that live in `feishu-card.ts`.
 */

import {
  metaString,
  stripSlackMrkdwn,
  truncateForCard,
  type FeishuV1Card,
} from './feishu-card.js';

export function buildAgentPaidConfirmCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): FeishuV1Card {
  const q = metaString(meta, 'agentQ') ?? '';
  const idLabel = metaString(meta, 'instructionId') ?? 'agent';
  const body = [
    `**确认调用 \`/${idLabel}\` ?**`,
    '该指令会触发外部付费 LLM 调用 + 多步指令。',
    '',
    `原始问题：\`${truncateForCard(stripSlackMrkdwn(q))}\``,
  ].join('\n');
  void text;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'purple',
      title: { tag: 'plain_text', content: `❓ /${idLabel} 需要确认` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✓ 确认' },
            type: 'primary',
            // Per Feishu card v1 spec, `value` must be an Object — Feishu
            // round-trips it untouched; passing a stringified JSON makes
            // the click event arrive with a string value (or not at all
            // on some app types) and the parser then fails.
            value: { action: 'confirm', agentQ: q },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✗ 取消' },
            type: 'danger',
            value: { action: 'cancel' },
          },
        ],
      },
    ],
  };
}

/**
 * Generic "this command will spend credits — confirm?" card for any
 * instruction tagged `requiresImConfirm`. Distinct from the agent
 * paid-confirm card because the round-trip is `/<cmd> confirm=1 <args>`
 * rather than `/agent confirm=1 q=...`. Args are serialised onto the
 * button value and echoed back unchanged on click.
 */
export function buildInstructionPaidConfirmCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): FeishuV1Card {
  void text;
  const cmd = metaString(meta, 'confirmCmd') ?? metaString(meta, 'instructionId') ?? 'instruction';
  const argsObj = readStringArgs(meta['confirmArgs']);
  const argsLine = Object.entries(argsObj)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const body = [
    `**确认调用 \`/${cmd}\` ?**`,
    '该指令会触发外部付费 LLM 调用。',
    argsLine.length > 0 ? `参数：\`${truncateForCard(stripSlackMrkdwn(argsLine))}\`` : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n');
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'purple',
      title: { tag: 'plain_text', content: `❓ /${cmd} 需要确认` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      buildPaidConfirmActions(cmd, argsObj),
    ],
  };
}

function readStringArgs(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function buildPaidConfirmActions(cmd: string, argsObj: Readonly<Record<string, string>>): unknown {
  return {
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '✓ 确认' },
        type: 'primary',
        value: { action: 'confirm', cmd, cmdArgs: argsObj },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '✗ 取消' },
        type: 'danger',
        value: { action: 'cancel', cmd },
      },
    ],
  };
}

export function buildAgentToolProposalCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
): FeishuV1Card {
  const correlationId = metaString(meta, 'correlationId') ?? '';
  const body = [
    `**Agent 申请执行以下工具调用：**`,
    truncateForCard(stripSlackMrkdwn(text)),
    `（5 分钟后自动失效）`,
  ].join('\n\n');
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'purple',
      title: { tag: 'plain_text', content: '❓ Agent 工具调用确认' },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✓ 批准' },
            type: 'primary',
            value: { action: 'confirm', correlationId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✗ 取消' },
            type: 'danger',
            value: { action: 'cancel', correlationId },
          },
        ],
      },
    ],
  };
}

/**
 * Re-render an interactive confirm card as a "decided" card after the
 * user clicks ✓ / ✗. Same body shape, but the action row is replaced
 * with a single note line so the user can see at a glance which choice
 * was recorded — a clicked card that still shows live buttons looks
 * like nothing happened.
 *
 * Used by the Feishu adapter via two paths:
 *   - HTTP Card Request URL callback → returned synchronously in the
 *     response so Feishu does the swap atomically.
 *   - WS `card.action.trigger` → patched via `im.v1.message.patch`
 *     since WS callbacks have no synchronous response channel.
 */
export function buildDecidedConfirmCard(args: {
  readonly headerTitle: string;
  readonly bodyMd: string;
  readonly decision: 'approved' | 'cancelled';
  readonly operatorOpenId?: string;
  readonly decidedAtIso: string;
}): FeishuV1Card {
  const decisionLabel =
    args.decision === 'approved' ? '✓ 已确认 — 正在执行' : '✗ 已取消 — 不会再执行';
  const operatorTail =
    args.operatorOpenId !== undefined && args.operatorOpenId.length > 0
      ? ` · by ${args.operatorOpenId.slice(0, 12)}…`
      : '';
  return {
    config: { wide_screen_mode: true },
    header: {
      template: args.decision === 'approved' ? 'green' : 'grey',
      title: {
        tag: 'plain_text',
        content:
          args.decision === 'approved'
            ? args.headerTitle.replace(/^[❓]\s*/u, '✓ ').replace(/需要确认$/u, '已确认')
            : args.headerTitle.replace(/^[❓]\s*/u, '✗ ').replace(/需要确认$/u, '已取消'),
      },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: args.bodyMd } },
      {
        tag: 'note',
        elements: [
          {
            tag: 'lark_md',
            content: `${decisionLabel}${operatorTail} · ${args.decidedAtIso.slice(11, 19)} UTC`,
          },
        ],
      },
    ],
  };
}
