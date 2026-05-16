/**
 * `/sector` cell — list sectors visible to the caller.
 *
 * Handler: pulls visible sectors from `SectorsService` and packages
 * each into `SectorListRow` (typed data only — no rendering strings).
 * Renderer: `renderSector` (pure).
 */

import type { InstructionCell, ResultOf } from '@quant/shared';

import { SectorsService } from '../../sectors/sectors.service.js';
import type { BeEnv } from '../be-types.js';
import { renderSector } from './sector.render.js';

type SectorListResult = ResultOf<'sector'>;

export interface SectorCellDeps {
  readonly sectors: SectorsService;
}

export function buildSectorCell(deps: SectorCellDeps): InstructionCell<BeEnv, 'sector'> {
  return {
    async handler(_args, ctx): Promise<SectorListResult> {
      const list = deps.sectors.listVisibleTo(ctx.userId);
      return {
        rows: list.map((s) => ({
          id: s.id,
          name: s.name,
          published: s.published,
          codeCount: s.codes.length,
          createdBy: s.createdBy,
          isOwn: s.createdBy === ctx.userId,
        })),
      };
    },
    renderer(envelope) {
      return renderSector(envelope);
    },
  };
}
