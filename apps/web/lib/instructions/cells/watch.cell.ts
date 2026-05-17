/**
 * FE `/watch` cell — list watch tasks.
 *
 * Migration note: legacy `watch list` renderer included a `d`-key
 * delete shortcut and a guided multi-condition `watch add` form.
 * Those FE-only flows aren't carried over; users invoke
 * `watch.remove id=wN` / `watch.add code=... market=... group=...`
 * (manifest-shaped) directly.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { ANSI, paint, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type WatchListResult = ResultOf<'watch'>;

export function buildWatchCell(): InstructionCell<FeEnv, 'watch'> {
  return {
    async handler(args, ctx): Promise<WatchListResult> {
      const env = await ctx.api.invoke('watch', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const r = envelope.data;
      if (r.tasks.length === 0) {
        return textOk(paint('no watch tasks — try `watch.add code=... market=a group=default`', ANSI.gray));
      }
      const lines: string[] = [paint('IDX  MKT  CODE     NAME             GROUP        EN  HIT', ANSI.bold)];
      for (const t of r.tasks) {
        lines.push(
          `${pad(`w${String(t.idx)}`, 4)} ${pad(t.market, 4)} ${pad(t.code, 8)} ${pad(t.name, 16)} ${pad(t.groupName, 12)} ${t.enabled ? 'Y' : 'N'}   ${String(t.hitCount)}`,
        );
      }
      return textOk(lines.join('\n'));
    },
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}
