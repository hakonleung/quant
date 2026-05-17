/**
 * FE `/analyze.sector` cell — sector-aggregate sentiment.
 *
 * Result schema is still `LegacyOutputSchema` ({text, meta?}) — BE
 * pre-formats. Handler thinly invokes; renderer emits text.
 * Force-confirm flow mirrors `analyze.cell.ts`.
 */

import {
  InstructionDispatchError,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';
import { canceledResolution, confirmPrompt, interactive, textErr, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type AnalyzeSectorResult = ResultOf<'analyze.sector'>;

export function buildAnalyzeSectorCell(): InstructionCell<FeEnv, 'analyze.sector'> {
  return {
    async handler(args, ctx): Promise<AnalyzeSectorResult> {
      if (args.fresh && !args.confirm) {
        throw new InstructionDispatchError(
          'confirm-required',
          JSON.stringify({ id: args.id }),
        );
      }
      const env = await ctx.api.invoke('analyze.sector', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        if (envelope.error.code === 'confirm-required') {
          const p = safeParse(envelope.error.message);
          return interactive(
            confirmPrompt({
              title: `analyze.sector ${p.id} fresh (LLM, paid)`,
              danger: true,
              onYes: () => ({
                kind: 'command',
                line: `analyze.sector id=${p.id} fresh=1 confirm=1`,
              }),
              onNo: () => canceledResolution,
            }),
          );
        }
        return textErr(envelope.error.message);
      }
      return textOk(envelope.data.text);
    },
  };
}

function safeParse(raw: string): { id: string } {
  try {
    const p = JSON.parse(raw) as { id?: unknown };
    return { id: typeof p.id === 'string' ? p.id : '' };
  } catch {
    return { id: '' };
  }
}
