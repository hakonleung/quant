/**
 * Watch fetch job — one envelope per (user, market, code) due-tick.
 *
 * Produced by `WatchScheduler` every master tick; consumed by
 * `WatchWorker`. Dedup id is `watch:userId:market:code` so a slow worker
 * cannot stack multiple ticks for the same task.
 */

import type { WatchMarket } from '@quant/shared';

export interface WatchJob {
  readonly kind: 'watch_eval';
  readonly userId: string;
  readonly market: WatchMarket;
  readonly code: string;
}
