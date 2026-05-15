import type { CommandSpec } from '../registry.js';
import { textErr, textOk } from '../widgets/helpers.js';

/**
 * `update` — fire the unified daily scan in the orchestrator
 * (meta + kline enqueue, then blacklist + dynamic sectors as the
 * settlement tail). Same code path as the 16:00 BJT cron.
 *
 * Side-effecting fetch happens inline (not via the action runner) because
 * orchestration scans aren't read/cacheable; the BFF returns 202 and the
 * actual progress streams via the socket queue snapshot → SYS row
 * capsules. The command exits immediately after the BFF acks.
 */
export const updateCommand: CommandSpec = {
  name: 'update',
  summary: 'Fire the unified daily scan (meta + kline + blacklist + sectors).',
  async run(_argv, ctx) {
    if (typeof fetch === 'undefined') {
      return textErr('update: fetch is unavailable in this runtime');
    }
    try {
      const res = await fetch(`/api/orchestration/scan`, {
        method: 'POST',
        signal: ctx.signal,
      });
      if (!res.ok) {
        const body = await res.text();
        return textErr(`update: HTTP ${String(res.status)} ${body.slice(0, 80)}`);
      }
      const raw: unknown = await res.json().catch(() => null);
      const startedAt =
        raw !== null && typeof raw === 'object' && 'startedAt' in raw
          ? String((raw as { startedAt: unknown }).startedAt)
          : new Date().toISOString();
      // Tell the client-side caches that the upstream data is now
      // changing. The scan runs async — invalidating eagerly means the
      // next render of EQ.LIST / FOCUS / dashboard will re-fetch and
      // pick up rows as the gateway publishes them. The socket queue
      // snapshot drives the SYS-row "scanning" indicator until drain.
      ctx.stores.revalidate?.('all');
      return textOk(`update dispatched · ${startedAt.slice(11, 19)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return textErr(`update: ${msg}`);
    }
  },
};
