import type { CommandSpec } from '../registry.js';
import { textErr, textOk } from '../widgets/helpers.js';

/**
 * `update meta`  — trigger a full meta scan in the orchestrator.
 * `update kline` — same for kline.
 * `update all`   — both.
 *
 * Side-effecting fetch happens inline (not via the action runner) because
 * orchestration scans aren't read/cacheable; the BFF returns 202 and the
 * actual progress streams via SSE → SYS row capsules. The command exits
 * immediately after the BFF acks.
 */

const KIND = ['meta', 'kline', 'all'] as const;
type Kind = (typeof KIND)[number];

function isKind(s: string): s is Kind {
  return (KIND as readonly string[]).includes(s);
}

export const updateCommand: CommandSpec = {
  name: 'update',
  summary: 'Trigger a meta / kline scan. Subcommands: meta, kline, all.',
  subcommands: ['meta', 'kline', 'all'],
  async run(argv, ctx) {
    const sub = argv.positional[0];
    if (sub === undefined || !isKind(sub)) {
      return textErr('usage: update meta | kline | all');
    }
    if (typeof fetch === 'undefined') {
      return textErr('update: fetch is unavailable in this runtime');
    }
    try {
      const res = await fetch(`/api/orchestration/scan?kind=${sub}`, {
        method: 'POST',
        signal: ctx.signal,
      });
      if (!res.ok) {
        const body = await res.text();
        return textErr(`update ${sub}: HTTP ${String(res.status)} ${body.slice(0, 80)}`);
      }
      const raw: unknown = await res.json().catch(() => null);
      const startedAt =
        raw !== null && typeof raw === 'object' && 'startedAt' in raw
          ? String((raw as { startedAt: unknown }).startedAt)
          : new Date().toISOString();
      return textOk(`update ${sub} dispatched · ${startedAt.slice(11, 19)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return textErr(`update ${sub}: ${msg}`);
    }
  },
};
