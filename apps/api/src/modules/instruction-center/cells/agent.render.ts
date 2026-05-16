/**
 * Pure rendering for `/agent`. Trigger ack carries jobId + maxToolCalls
 * so the user can correlate the streamed `instruction.agent.delta`
 * frames back to this invocation.
 *
 * Error envelope passes through unchanged — the `confirm-required`
 * path's JSON-encoded message is decoded by the IM card / term widget,
 * not the renderer.
 */

import {
  okResult,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import type { ImOutput } from '../be-types.js';

type AgentResult = ResultOf<'agent'>;

export function renderAgent(envelope: InstructionEnvelope<AgentResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const { jobId, maxToolCalls } = envelope.data;
  return okResult(
    `▶ /agent 启动 jobId=${jobId} maxSteps=${String(maxToolCalls)} — 通过 instruction.agent.delta 流接收增量。`,
  );
}
