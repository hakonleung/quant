/**
 * `/sector.publish` and `/sector.unpublish` cells — owner-only toggle of
 * the sector's `published` flag. Both call the same `setPublished` API
 * with opposite booleans; the cell factories diverge only in which
 * `action` literal they emit for the renderer.
 *
 * `QuantError` codes are mapped onto the cell's error envelope
 * (`forbidden` / `not-found`) via `InstructionDispatchError` so the IM
 * surface keeps its distinct status codes; unknown throws propagate to
 * the executor's `handler` fallback.
 */

import {
  InstructionDispatchError,
  QuantError,
  type InstructionCell,
} from '@quant/shared';

import { SectorsService } from '../../sectors/sectors.service.js';
import type { BeEnv } from '../be-types.js';
import { renderSectorAck } from './sector-ack.render.js';

export interface SectorToggleDeps {
  readonly sectors: SectorsService;
}

export function buildSectorPublishCell(
  deps: SectorToggleDeps,
): InstructionCell<BeEnv, 'sector.publish'> {
  return {
    async handler(args, ctx) {
      try {
        await deps.sectors.setPublished(ctx.userId, args.id, true);
        return { id: args.id, action: 'published' };
      } catch (err) {
        throw mapSectorMutationError(err);
      }
    },
    renderer(envelope) {
      return renderSectorAck(envelope);
    },
  };
}

export function buildSectorUnpublishCell(
  deps: SectorToggleDeps,
): InstructionCell<BeEnv, 'sector.unpublish'> {
  return {
    async handler(args, ctx) {
      try {
        await deps.sectors.setPublished(ctx.userId, args.id, false);
        return { id: args.id, action: 'unpublished' };
      } catch (err) {
        throw mapSectorMutationError(err);
      }
    },
    renderer(envelope) {
      return renderSectorAck(envelope);
    },
  };
}

/**
 * Convert `QuantError(FORBIDDEN | NOT_FOUND)` into the cell's
 * structured error envelope so the IM listener / FE renderer can
 * branch on `error.code` instead of grepping the message. Other
 * throws propagate untouched so the executor's `handler` fallback
 * (and the async-job logger) sees the original stack.
 */
export function mapSectorMutationError(err: unknown): unknown {
  if (err instanceof QuantError) {
    if (err.code === 'FORBIDDEN') {
      return new InstructionDispatchError('forbidden', err.message);
    }
    if (err.code === 'NOT_FOUND') {
      return new InstructionDispatchError('not-found', err.message);
    }
  }
  return err;
}
