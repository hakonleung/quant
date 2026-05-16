/**
 * `/watch.group <name> <on|off|pause|resume>` cell — toggle a watch
 * group's enabled flag without deleting it. Counters and `lastHitPrice`
 * survive the toggle.
 *
 * Any error from `WatchService.patchGroup` is treated as `not-found`
 * (preserves the legacy handler's behaviour where the only practical
 * failure was "group does not exist"). Renderer echoes the resulting
 * enabled state alongside the verb the user actually typed so the
 * pause/resume vs on/off distinction stays visible.
 */

import {
  InstructionDispatchError,
  okResult,
  type InstructionCell,
  type InstructionEnvelope,
  type WatchGroupResult,
} from '@quant/shared';

import { WatchService } from '../../watch/watch.service.js';
import type { BeEnv, ImOutput } from '../be-types.js';

export interface WatchGroupCellDeps {
  readonly watch: WatchService;
}

export function buildWatchGroupCell(
  deps: WatchGroupCellDeps,
): InstructionCell<BeEnv, 'watch.group'> {
  return {
    async handler(args, ctx): Promise<WatchGroupResult> {
      const enabled = args.state === 'on' || args.state === 'resume';
      try {
        const group = await deps.watch.patchGroup(ctx.userId, args.name, { enabled });
        return {
          name: group.name,
          enabled: group.enabled,
          requestedState: args.state,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new InstructionDispatchError('not-found', msg);
      }
    },
    renderer(envelope) {
      return renderWatchGroup(envelope);
    },
  };
}

export function renderWatchGroup(envelope: InstructionEnvelope<WatchGroupResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const r = envelope.data;
  const verb = r.enabled ? 'resumed' : 'paused';
  return okResult(`watch group ${r.name} ${verb} (${r.requestedState})`);
}
