/**
 * `/ta.sector <id>` cell — sector-level TA fan-out + narrative.
 *
 * Handler resolves the sector, validates member count, fans
 * `TaService.analyzeSector`. Error mapping mirrors the legacy handler:
 *   - QuantError(NOT_FOUND) on resolveVisible → not-found
 *   - empty / oversized member list → validation
 *   - QuantError on analyzeSector → handler
 *
 * No peek hook: the aggregate result has no sector-level cache (only
 * per-stock caches inside `analyzeSector`), so the IM gate always
 * shows the confirm card. Matches legacy `TaSectorInstructionHandler`
 * behaviour.
 */

import {
  InstructionDispatchError,
  QuantError,
  type InstructionCell,
  type TaSectorResult,
} from '@quant/shared';

import { SectorsService } from '../../sectors/sectors.service.js';
import { TaService } from '../../ta/ta.service.js';
import type { BeEnv } from '../be-types.js';
import { renderTaSector } from './ta.render.js';

const MAX_SECTOR_CODES = 50;

export interface TaSectorCellDeps {
  readonly ta: TaService;
  readonly sectors: SectorsService;
}

export function buildTaSectorCell(
  deps: TaSectorCellDeps,
): InstructionCell<BeEnv, 'ta.sector'> {
  return {
    async handler(args, ctx): Promise<TaSectorResult> {
      let sector;
      try {
        sector = deps.sectors.resolveVisible(ctx.userId, args.id);
      } catch (err) {
        if (err instanceof QuantError && err.code === 'NOT_FOUND') {
          throw new InstructionDispatchError('not-found', err.message);
        }
        throw err;
      }
      if (sector.codes.length === 0) {
        throw new InstructionDispatchError(
          'validation',
          `sector ${sector.id} has no member codes`,
        );
      }
      if (sector.codes.length > MAX_SECTOR_CODES) {
        throw new InstructionDispatchError(
          'validation',
          `sector ${sector.id} has ${String(sector.codes.length)} codes; max ${String(MAX_SECTOR_CODES)} per /ta.sector call`,
        );
      }
      let analysis;
      try {
        analysis = await deps.ta.analyzeSector({
          codes: sector.codes,
          label: sector.name,
          bypassCache: args.fresh,
          ctx: { userId: ctx.userId, traceId: ctx.traceId },
        });
      } catch (err) {
        if (err instanceof QuantError) {
          throw new InstructionDispatchError('handler', err.message);
        }
        throw err;
      }
      return { sectorId: sector.id, sectorName: sector.name, analysis };
    },
    renderer(envelope) {
      return renderTaSector(envelope);
    },
  };
}
