/**
 * FE `/clear` cell — pure-FE terminal scrollback control.
 *
 * No BE call. Handler picks the engine event (clearAll vs clearLast).
 * Renderer wraps it as `kind: 'engine'` so the reducer drops the
 * appropriate scrollback span.
 *
 * `clear last N` accounts for the command-line entry itself — we
 * bump `count` by 1 so the `clear last N` prompt also vanishes
 * (matches legacy behaviour).
 */

import {
  InstructionDispatchError,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';

import type { FeEnv } from '../fe-types.js';

type ClearResult = ResultOf<'clear'>;

export function buildClearCell(): InstructionCell<FeEnv, 'clear'> {
  return {
    async handler(args): Promise<ClearResult> {
      if (args.sub === undefined) return { kind: 'all' };
      if (args.sub === 'last') {
        const count = args.count;
        if (count === undefined) {
          // Default: drop the most recent interaction.
          return { kind: 'last', count: 1 + 1 };
        }
        // Bump by 1 so the `clear last N` prompt itself also vanishes.
        return { kind: 'last', count: count + 1 };
      }
      throw new InstructionDispatchError('validation', `unknown clear subcommand`);
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return {
          kind: 'text',
          status: 'err',
          tail: { body: `${envelope.error.code}: ${envelope.error.message}` },
        };
      }
      if (envelope.data.kind === 'all') {
        return { kind: 'engine', events: [{ kind: 'clearAll' }] };
      }
      return {
        kind: 'engine',
        events: [{ kind: 'clearLast', count: envelope.data.count }],
      };
    },
  };
}
