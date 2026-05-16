/**
 * `/sector.rm` cell — owner-only sector delete. Uses the same
 * `mapSectorMutationError` translator as the publish toggles so the
 * three sector mutation cells emit consistent error codes.
 */

import type { InstructionCell } from '@quant/shared';

import { SectorsService } from '../../sectors/sectors.service.js';
import type { BeEnv } from '../be-types.js';
import { renderSectorAck } from './sector-ack.render.js';
import { mapSectorMutationError } from './sector-publish.cell.js';

export interface SectorRmCellDeps {
  readonly sectors: SectorsService;
}

export function buildSectorRmCell(
  deps: SectorRmCellDeps,
): InstructionCell<BeEnv, 'sector.rm'> {
  return {
    async handler(args, ctx) {
      try {
        await deps.sectors.remove(ctx.userId, args.id);
        return { id: args.id, action: 'deleted' };
      } catch (err) {
        throw mapSectorMutationError(err);
      }
    },
    renderer(envelope) {
      return renderSectorAck(envelope);
    },
  };
}
