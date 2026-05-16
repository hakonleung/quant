/**
 * `/agent.confirm` cell — continuation handler for a paused agent loop.
 *
 *   - correlationId from the matching `instruction.agent.delta` frame
 *   - approve=true → run the parked tool calls (loop resumes, may
 *     pause again on the next sensitive batch)
 *   - approve=false → loop summarises with "user cancelled" + emits done
 *
 * Errors:
 *   - not-found: correlationId expired / unknown
 *   - forbidden: snapshot belongs to a different user (defence-in-depth)
 *
 * Like /agent, the actual resume runs detached; the trigger ack
 * returns immediately.
 */

import {
  InstructionDispatchError,
  type InstructionCell,
} from '@quant/shared';

import { AgentPendingStore } from '../../agent/agent-pending.store.js';
import { AgentService } from '../../agent/agent.service.js';
import type { BeEnv } from '../be-types.js';
import { renderAgentConfirm } from './agent-confirm.render.js';

export interface AgentConfirmCellDeps {
  readonly agent: AgentService;
  readonly pending: AgentPendingStore;
}

export function buildAgentConfirmCell(
  deps: AgentConfirmCellDeps,
): InstructionCell<BeEnv, 'agent.confirm'> {
  return {
    async handler(args, ctx) {
      const snapshot = deps.pending.take(args.correlationId);
      if (snapshot === null) {
        throw new InstructionDispatchError(
          'not-found',
          `agent confirmation expired or unknown: ${args.correlationId}`,
        );
      }
      if (snapshot.userId !== ctx.userId) {
        throw new InstructionDispatchError(
          'forbidden',
          'agent confirmation does not belong to this user',
        );
      }
      void deps.agent.resume(snapshot, args.approve, ctx).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(
          `/agent.confirm resume failed correlationId=${args.correlationId} err=${String(err)}`,
        );
      });
      return { correlationId: args.correlationId, approve: args.approve };
    },
    renderer(envelope) {
      return renderAgentConfirm(envelope);
    },
  };
}
