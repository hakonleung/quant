/**
 * FE `/cache` cell — inspect / clear the terminal data runner cache.
 *
 * Pure-FE. `stats` (default) reads `ctx.actions.stats()`; `clear`
 * fires `ctx.actions.invalidate([])` to drop every entry.
 *
 * The legacy command supported variadic prefix args (`cache clear meta
 * 600519`) — kept out of scope here; the new model takes a single
 * `sub` positional. Add a `prefix?: string` field if a real consumer
 * appears.
 */

import {
  InstructionDispatchError,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';
import { renderTable, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type CacheResult = ResultOf<'cache'>;

export function buildCacheCell(): InstructionCell<FeEnv, 'cache'> {
  return {
    async handler(args, ctx): Promise<CacheResult> {
      const sub = args.sub ?? 'stats';
      if (sub === 'stats') {
        const s = ctx.actions.stats();
        return { kind: 'stats', entries: s.entries, hits: s.hits, misses: s.misses };
      }
      if (sub === 'clear') {
        ctx.actions.invalidate([]);
        return { kind: 'cleared' };
      }
      throw new InstructionDispatchError('validation', `unknown cache subcommand: ${sub}`);
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return {
          kind: 'text',
          status: 'err',
          tail: { body: `${envelope.error.code}: ${envelope.error.message}` },
        };
      }
      if (envelope.data.kind === 'cleared') {
        return textOk('cleared (prefix=*)');
      }
      const { entries, hits, misses } = envelope.data;
      return textOk(
        renderTable(
          [
            { K: 'entries', V: entries },
            { K: 'hits', V: hits },
            { K: 'misses', V: misses },
          ],
          [
            { key: 'K', header: 'KEY', max: 12 },
            { key: 'V', header: 'VAL', align: 'right' },
          ],
        ),
      );
    },
  };
}
