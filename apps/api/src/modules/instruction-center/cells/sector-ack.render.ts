/**
 * Shared renderer for the three sector mutation cells
 * (`sector.publish` / `sector.unpublish` / `sector.rm`). Each produces
 * a `SectorAckResult { id, action }`; the verb table here keeps the
 * IM/term wording consistent — "published s1" / "unpublished s1" /
 * "deleted s1".
 *
 * Error envelope is forwarded verbatim so the cell handler decides
 * the error code (`forbidden` / `not-found` for `QuantError`s, the
 * usual `handler` fallback otherwise).
 */

import {
  okResult,
  type InstructionEnvelope,
  type SectorAckResult,
} from '@quant/shared';

import type { ImOutput } from '../be-types.js';

const VERB: Record<SectorAckResult['action'], string> = {
  published: 'published',
  unpublished: 'unpublished',
  deleted: 'deleted',
};

export function renderSectorAck(envelope: InstructionEnvelope<SectorAckResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const { id, action } = envelope.data;
  return okResult(`${VERB[action]} ${id}`);
}
