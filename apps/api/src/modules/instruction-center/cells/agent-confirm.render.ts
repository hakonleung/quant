/**
 * Pure rendering for `/agent.confirm`. Trigger ack echoes the
 * correlationId + approve flag so the IM / term widget can correlate
 * back to the originating confirm card.
 */

import {
  okResult,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import type { ImOutput } from '../be-types.js';

type AgentConfirmResult = ResultOf<'agent.confirm'>;

export function renderAgentConfirm(
  envelope: InstructionEnvelope<AgentConfirmResult>,
): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const { correlationId, approve } = envelope.data;
  return okResult(
    `▶ /agent.confirm correlationId=${correlationId} approve=${String(approve)} — 续派中。`,
  );
}
