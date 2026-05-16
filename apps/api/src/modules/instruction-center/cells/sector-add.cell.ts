/**
 * `/sector.add` cell — upsert a sector pass-through.
 *
 * Wraps `SectorsService.upsert`. The legacy FE composes the sector
 * payload from a multi-step form (name → kind → codes); the cell
 * sees only the final shape via `args.sector`.
 */

import {
  InstructionDispatchError,
  QuantError,
  type InstructionCell,
  type InstructionResult,
  type ResultOf,
} from '@quant/shared';

import { SectorsService } from '../../sectors/sectors.service.js';
import type { BeEnv } from '../be-types.js';

type SectorAddResult = ResultOf<'sector.add'>;

export interface SectorAddCellDeps {
  readonly sectors: SectorsService;
}

export function buildSectorAddCell(
  deps: SectorAddCellDeps,
): InstructionCell<BeEnv, 'sector.add'> {
  return {
    async handler(args, ctx): Promise<SectorAddResult> {
      try {
        return await deps.sectors.upsert(ctx.userId, args.sector);
      } catch (err) {
        if (err instanceof QuantError) {
          throw new InstructionDispatchError('handler', err.message);
        }
        throw err;
      }
    },
    renderer(envelope): InstructionResult {
      if (!envelope.ok) return { ok: false, error: envelope.error };
      const s = envelope.data;
      return {
        ok: true,
        output: { text: `saved sector ${s.id}  "${s.name}"  codes=${String(s.count)}` },
      };
    },
  };
}
