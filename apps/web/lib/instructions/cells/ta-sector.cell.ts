/**
 * FE `/ta.sector` cell — sector-aggregate TA.
 *
 * Mirrors ta.cell.ts confirm flow. Renders a compact summary of
 * the per-member cards from `TaSectorAnalysis`.
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

type TaSectorResult = ResultOf<'ta.sector'>;

export function buildTaSectorCell(): InstructionCell<FeEnv, 'ta.sector'> {
  return {
    async handler(args, ctx): Promise<TaSectorResult> {
      if (args.fresh && args.confirm !== true) {
        throw new InstructionDispatchError(
          'confirm-required',
          JSON.stringify({ id: args.id }),
        );
      }
      const env = await ctx.api.invoke('ta.sector', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        if (envelope.error.code === 'confirm-required') {
          const p = safeParse(envelope.error.message);
          return interactive(
            confirmPrompt({
              title: `ta.sector ${p.id} fresh (LLM, paid)`,
              danger: true,
              onYes: () => ({
                kind: 'command',
                line: `ta.sector id=${p.id} fresh=1 confirm=1`,
              }),
              onNo: () => canceledResolution,
            }),
          );
        }
        return textErr(envelope.error.message);
      }
      const r = envelope.data;
      const a = r.analysis;
      const lines: string[] = [
        paint(`sector ${r.sectorName} TA (${String(a.codes.length)} codes)`, ANSI.bold, ANSI.cyan),
        `summary: ${a.summary}`,
      ];
      for (const m of a.members.slice(0, 10)) {
        lines.push(`  ${m.code}  ${m.name}  ${m.trend.direction}  ${m.headline}`);
      }
      if (a.members.length > 10) {
        lines.push(`  … +${String(a.members.length - 10)} more`);
      }
      return textOk(lines.join('\n'));
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
