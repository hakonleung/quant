/**
 * Pure rendering for `/update`. One-line ack — "started" vs
 * "coalesced" wording distinguishes a fresh launch from joining an
 * in-flight scan. Output matches legacy `UpdateInstructionHandler`
 * exactly so existing IM users see the same message after migration.
 */

import {
  okResult,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import type { ImOutput } from '../be-types.js';

type UpdateResult = ResultOf<'update'>;

export function renderUpdate(envelope: InstructionEnvelope<UpdateResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const { started, traceId } = envelope.data;
  return okResult(
    started
      ? `scan started: traceId=${traceId}`
      : `scan already in flight (coalesced): traceId=${traceId}`,
  );
}
