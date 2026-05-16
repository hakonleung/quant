/**
 * `/sector.refresh` cell — re-run a dynamic sector's NL screen and persist.
 *
 * Any user (owner or not) may trigger; the codes/lastScreenedAt update
 * is visible to everyone who can see the sector. Migrated from the
 * legacy `SectorRefreshInstructionHandler`.
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

type SectorRefreshResult = ResultOf<'sector.refresh'>;

export interface SectorRefreshCellDeps {
  readonly sectors: SectorsService;
}

export function buildSectorRefreshCell(
  deps: SectorRefreshCellDeps,
): InstructionCell<BeEnv, 'sector.refresh'> {
  return {
    async handler(args, ctx): Promise<SectorRefreshResult> {
      try {
        return await deps.sectors.refreshDynamic(ctx.userId, args.id, ctx.traceId);
      } catch (err) {
        if (err instanceof QuantError) {
          if (err.code === 'NOT_FOUND') {
            throw new InstructionDispatchError('not-found', err.message);
          }
          if (err.code === 'INVALID_ARGUMENT') {
            throw new InstructionDispatchError('validation', err.message);
          }
        }
        throw err;
      }
    },
    renderer(envelope): InstructionResult {
      if (!envelope.ok) return { ok: false, error: envelope.error };
      const s = envelope.data;
      return {
        ok: true,
        output: {
          text: `refreshed sector ${s.name}: codes=${String(s.count)} chgPct=${String(s.chgPct ?? '—')}`,
        },
      };
    },
  };
}
