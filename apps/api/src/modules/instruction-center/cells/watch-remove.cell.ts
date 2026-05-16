/**
 * `/watch.remove <wid>` cell.
 *
 * Accepts both `w1` and bare `1`; the leading `w` is stripped before
 * parseInt. Bad ids become a `validation` error envelope; missing task
 * becomes `not-found`. Renderer emits a one-liner with the removed
 * w-index for symmetry with `watch.add`'s ack.
 */

import {
  InstructionDispatchError,
  okResult,
  type InstructionCell,
  type InstructionEnvelope,
  type WatchRemoveResult,
} from '@quant/shared';

import { WatchTaskStore } from '../../watch/watch-task.store.js';
import type { BeEnv, ImOutput } from '../be-types.js';

export interface WatchRemoveCellDeps {
  readonly taskStore: WatchTaskStore;
}

export function buildWatchRemoveCell(
  deps: WatchRemoveCellDeps,
): InstructionCell<BeEnv, 'watch.remove'> {
  return {
    async handler(args, ctx): Promise<WatchRemoveResult> {
      const raw = args.id.replace(/^w/iu, '');
      const idx = parseInt(raw, 10);
      if (!Number.isInteger(idx) || idx < 1) {
        throw new InstructionDispatchError(
          'validation',
          `invalid watch id "${args.id}"; expected w1, w2, … or bare number`,
        );
      }
      const removed = await deps.taskStore.deleteByIdx(ctx.userId, idx);
      if (removed === undefined) {
        throw new InstructionDispatchError('not-found', `watch task w${String(idx)} not found`);
      }
      return { idx };
    },
    renderer(envelope) {
      return renderWatchRemove(envelope);
    },
  };
}

export function renderWatchRemove(
  envelope: InstructionEnvelope<WatchRemoveResult>,
): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  return okResult(`removed w${String(envelope.data.idx)}`);
}
