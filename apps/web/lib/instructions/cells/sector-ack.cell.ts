/**
 * Shared FE renderer for the sync-ack sector ops: publish / unpublish / rm.
 * Each builder wraps the same template against a different id so the
 * mapped-type FeEnv coverage check still binds per-id correctness.
 */

import type {
  AllInstructionIds,
  InstructionCell,
  ResultOf,
} from '@quant/shared';
import { textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type AckId = 'sector.publish' | 'sector.unpublish' | 'sector.rm';

function buildAckCell<I extends AckId>(id: I): InstructionCell<FeEnv, I> {
  return {
    async handler(args, ctx): Promise<ResultOf<I>> {
      const env = await ctx.api.invoke<I>(
        id as AllInstructionIds as I,
        args,
        { signal: ctx.signal },
      );
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const d = envelope.data as ResultOf<'sector.publish'>;
      return textOk(`sector ${d.id} ${d.action}`);
    },
  };
}

export function buildSectorPublishCell(): InstructionCell<FeEnv, 'sector.publish'> {
  return buildAckCell('sector.publish');
}
export function buildSectorUnpublishCell(): InstructionCell<FeEnv, 'sector.unpublish'> {
  return buildAckCell('sector.unpublish');
}
export function buildSectorRmCell(): InstructionCell<FeEnv, 'sector.rm'> {
  return buildAckCell('sector.rm');
}
