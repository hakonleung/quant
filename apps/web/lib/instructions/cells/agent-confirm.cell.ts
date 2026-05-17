/**
 * FE `/agent.confirm` cell — approve or reject a pending agent tool batch.
 *
 * Triggered by the user typing `agent.confirm correlationId=… approve=…`
 * after the streaming `confirm` frame surfaces in the agent loop. Thin
 * proxy — the BE side resumes the loop via AgentService.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type AgentConfirmResult = ResultOf<'agent.confirm'>;

export function buildAgentConfirmCell(): InstructionCell<FeEnv, 'agent.confirm'> {
  return {
    async handler(args, ctx): Promise<AgentConfirmResult> {
      const env = await ctx.api.invoke('agent.confirm', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const r = envelope.data;
      return textOk(`agent.confirm ${r.correlationId} → ${r.approve ? 'approved' : 'cancelled'}`);
    },
  };
}
