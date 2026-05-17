/**
 * FE `/ta` cell — single-stock technical analysis (paid LLM).
 *
 * Force-confirm flow mirrors analyze.cell.ts. Renderer prints the
 * trend headline + S/R levels + patterns from the typed `TaAnalysis`
 * payload.
 */

import {
  InstructionDispatchError,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';
import {
  ANSI,
  canceledResolution,
  confirmPrompt,
  interactive,
  paint,
  textErr,
  textOk,
} from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type TaAnalysis = ResultOf<'ta'>;

export function buildTaCell(): InstructionCell<FeEnv, 'ta'> {
  return {
    async handler(args, ctx): Promise<TaAnalysis> {
      if (args.fresh && !args.confirm) {
        throw new InstructionDispatchError(
          'confirm-required',
          JSON.stringify({ code: args.code }),
        );
      }
      const env = await ctx.api.invoke('ta', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        if (envelope.error.code === 'confirm-required') {
          const p = safeParse(envelope.error.message);
          return interactive(
            confirmPrompt({
              title: `ta ${p.code} fresh (LLM, paid)`,
              danger: true,
              onYes: () => ({
                kind: 'command',
                line: `ta code=${p.code} fresh=1 confirm=1`,
              }),
              onNo: () => canceledResolution,
            }),
          );
        }
        return textErr(envelope.error.message);
      }
      return textOk(formatTa(envelope.data));
    },
  };
}

function safeParse(raw: string): { code: string } {
  try {
    const p = JSON.parse(raw) as { code?: unknown };
    return { code: typeof p.code === 'string' ? p.code : '' };
  } catch {
    return { code: '' };
  }
}

function formatTa(a: TaAnalysis): string {
  const lines: string[] = [
    paint(`${a.code} TA  asof ${a.asof}  bars=${String(a.barsCount)}`, ANSI.bold, ANSI.cyan),
    `trend:    ${a.trend.direction}  (conf ${a.trend.confidence.toFixed(2)})`,
    `summary:  ${a.trend.rationale}`,
  ];
  if (a.supportLevels.length > 0) {
    lines.push(`support:  ${a.supportLevels.map((l) => l.price).join(', ')}`);
  }
  if (a.resistanceLevels.length > 0) {
    lines.push(`resist:   ${a.resistanceLevels.map((l) => l.price).join(', ')}`);
  }
  if (a.patterns.length > 0) {
    lines.push(`patterns: ${a.patterns.join(', ')}`);
  }
  lines.push(`cached:   ${a.cachedAt}`);
  if (a.caveats.length > 0) {
    lines.push('');
    lines.push(paint('caveats:', ANSI.bold));
    for (const c of a.caveats) lines.push(`  ! ${c}`);
  }
  return lines.join('\n');
}
