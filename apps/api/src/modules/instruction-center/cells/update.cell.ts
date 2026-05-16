/**
 * `/update` cell — manually fire the unified daily scan (same code path
 * as the 16:00 BJT cron + the `POST /api/orchestration/scan` HTTP
 * endpoint).
 *
 * `CronOrchestrator.fireScan()` coalesces with any in-flight scan;
 * `started=false` means we joined an already-running scan rather than
 * launching a new one. Returns immediately — clients watch the
 * `queue.snapshot` socket topic for progress.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';

import { CronOrchestrator } from '../../orchestration/cron.orchestrator.js';
import type { BeEnv } from '../be-types.js';
import { renderUpdate } from './update.render.js';

type UpdateResult = ResultOf<'update'>;

export interface UpdateCellDeps {
  readonly cron: CronOrchestrator;
}

export function buildUpdateCell(deps: UpdateCellDeps): InstructionCell<BeEnv, 'update'> {
  return {
    async handler(_args, _ctx): Promise<UpdateResult> {
      const accepted = deps.cron.fireScan();
      return { started: accepted.started, traceId: accepted.traceId };
    },
    renderer(envelope) {
      return renderUpdate(envelope);
    },
  };
}
