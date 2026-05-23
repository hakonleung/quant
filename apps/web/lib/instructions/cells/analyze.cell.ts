/**
 * FE `/analyze` cell — single-stock sentiment.
 *
 * Two phases via `confirm-required`: without `args.confirm`, the
 * handler throws and the renderer surfaces a paid-confirm widget
 * that re-dispatches with `confirm=1`. With confirm, invoke the BE
 * cell and render the typed `Sentiment` payload.
 *
 * Output body uses the shared `sentimentLines()` formatter so that
 * the term surface, the IM/channel surface, and the AI.EQ pane all
 * render the same structured content (score / brief / drivers /
 * themes / products / signals / m&a / supply / research /
 * competitive / gaps / caveats). See CLAUDE.md §9.1 normalization —
 * one canonical representation, fanned out by surface chrome only.
 */

import {
  InstructionDispatchError,
  sentimentLines,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';
import {
  canceledResolution,
  confirmPrompt,
  interactive,
  textErr,
  textOk,
} from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type Sentiment = ResultOf<'analyze'>;

export function buildAnalyzeCell(): InstructionCell<FeEnv, 'analyze'> {
  return {
    async handler(args, ctx): Promise<Sentiment> {
      if (args.fresh && !args.confirm) {
        throw new InstructionDispatchError(
          'confirm-required',
          JSON.stringify({ code: args.code, fresh: true }),
        );
      }
      const env = await ctx.api.invoke('analyze', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        if (envelope.error.code === 'confirm-required') {
          const p = safeParse(envelope.error.message);
          return interactive(
            confirmPrompt({
              title: `analyze ${p.code} fresh (LLM, paid)`,
              danger: true,
              onYes: () => ({
                kind: 'command',
                line: `analyze code=${p.code} fresh=1 confirm=1`,
              }),
              onNo: () => canceledResolution,
            }),
          );
        }
        return textErr(envelope.error.message);
      }
      return textOk(formatSentiment(envelope.data));
    },
  };
}

function safeParse(raw: string): { code: string; fresh: boolean } {
  try {
    const p = JSON.parse(raw) as { code?: unknown; fresh?: unknown };
    return {
      code: typeof p.code === 'string' ? p.code : '',
      fresh: p.fresh === true,
    };
  } catch {
    return { code: '', fresh: false };
  }
}

function formatSentiment(s: Sentiment): string {
  return sentimentLines(s).join('\n');
}
