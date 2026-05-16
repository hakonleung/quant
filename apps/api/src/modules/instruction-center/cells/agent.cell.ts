/**
 * `/agent` cell — natural-language entry point. Triggers a detached
 * agent loop and returns a small "▶ started" ack. The actual output
 * streams via `instruction.agent.delta` socket frames keyed on jobId.
 *
 * Three error paths surface as cell envelope codes:
 *   - `confirm-required`: caller hasn't accepted the paid confirm yet.
 *     `error.message` is a JSON envelope the IM card / term widget
 *     parses to render the confirm surface; flipping `confirm=true`
 *     re-dispatches and reaches the success path.
 *   - `forbidden`: missing delivery target (no socket / IM context).
 *   - any other throw: propagates (loop start failure pre-detach).
 *
 * The loop itself runs detached via `.catch(console.error)` — by
 * design the cell returns immediately so the trigger ack reaches
 * the user before any LLM round-trip.
 */

import { randomUUID } from 'node:crypto';

import {
  InstructionDispatchError,
  type ChatMessage,
  type InstructionCell,
} from '@quant/shared';

import { AgentHistoryStore } from '../../agent/agent-history.store.js';
import { AgentService } from '../../agent/agent.service.js';
import type { AgentDeliveryTarget } from '../../agent/agent.types.js';
import type { AgentArgs } from '../../agent/dto/agent.dto.js';
import type { InstructionCtx } from '../../instruction/instruction.port.js';
import type { BeEnv } from '../be-types.js';
import { renderAgent } from './agent.render.js';

export interface AgentCellDeps {
  readonly agent: AgentService;
  readonly history: AgentHistoryStore;
}

export function buildAgentCell(deps: AgentCellDeps): InstructionCell<BeEnv, 'agent'> {
  return {
    async handler(args, ctx) {
      if (args.confirm !== true) {
        throw new InstructionDispatchError(
          'confirm-required',
          JSON.stringify({ q: args.q, kind: 'agent.paid' }),
        );
      }
      const delivery = pickDelivery(ctx);
      if (delivery === null) {
        throw new InstructionDispatchError(
          'forbidden',
          '/agent requires socket or IM context',
        );
      }
      const jobId = randomUUID();
      const maxToolCalls = deps.agent.resolveMaxToolCalls(args.maxToolCalls);
      const history = collectHistory(deps.history, args, ctx);
      // Detach: trigger ack returns immediately; the loop emits its own
      // text/done frames and a final-line summary on failure.
      void deps.agent
        .runFresh({ q: args.q, history, maxToolCalls, delivery, jobId, ctx })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`/agent run failed jobId=${jobId} err=${String(err)}`);
        });
      return { jobId, maxToolCalls };
    },
    renderer(envelope) {
      return renderAgent(envelope);
    },
  };
}

function collectHistory(
  store: AgentHistoryStore,
  args: AgentArgs,
  ctx: InstructionCtx,
): readonly ChatMessage[] {
  const messages: ChatMessage[] = [];
  const push = (role: 'user' | 'assistant' | 'tool', content: string): void => {
    if (role === 'tool') return; // tool turns need toolCallId we don't carry.
    messages.push({ role, content });
  };
  if (args.context !== undefined && args.context.length > 0) {
    for (const entry of args.context) push(entry.role, entry.content);
    return dropTrailingDuplicate(messages, args.q);
  }
  if (ctx.source === 'im' && ctx.channelId !== undefined) {
    const recent = store.recent(ctx.userId, ctx.channelId, 10);
    for (const entry of recent) push(entry.role, entry.content);
  }
  return dropTrailingDuplicate(messages, args.q);
}

function dropTrailingDuplicate(messages: ChatMessage[], q: string): ChatMessage[] {
  const last = messages.at(-1);
  if (last !== undefined && last.role === 'user' && last.content === q) {
    messages.pop();
  }
  return messages;
}

function pickDelivery(ctx: InstructionCtx): AgentDeliveryTarget | null {
  if (ctx.source === 'socket' || ctx.source === 'http') {
    return { kind: 'socket', userId: ctx.userId };
  }
  if (
    ctx.source === 'im' &&
    ctx.channelId !== undefined &&
    typeof ctx.target === 'string' &&
    ctx.target.length > 0
  ) {
    return { kind: 'im', channel: ctx.channelId, target: ctx.target, userId: ctx.userId };
  }
  return null;
}
