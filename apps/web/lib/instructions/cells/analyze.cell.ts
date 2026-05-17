/**
 * FE `/analyze` cell — single-stock sentiment.
 *
 * Two phases via `confirm-required`: without `args.confirm`, the
 * handler throws and the renderer surfaces a paid-confirm widget
 * that re-dispatches with `confirm=1`. With confirm, invoke the BE
 * cell and render the typed `Sentiment` payload (new schema —
 * coreDrivers / hotThemes / brief; no more topTheme / topDriver).
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

function formatScore(score: number): string {
  if (score > 0.66) return paint(score.toFixed(2), ANSI.green);
  if (score < 0.34) return paint(score.toFixed(2), ANSI.red);
  return paint(score.toFixed(2), ANSI.yellow);
}

function formatSentiment(s: Sentiment): string {
  const themes = s.hotThemes
    .slice(0, 3)
    .map((t) => t.label)
    .join(', ');
  const drivers = s.coreDrivers
    .slice(0, 3)
    .map((d) => d.summary)
    .join('; ');
  const lines: string[] = [
    paint(`${s.code} sentiment`, ANSI.bold, ANSI.cyan),
    `score:   ${formatScore(s.score)}`,
    `themes:  ${themes.length > 0 ? themes : '—'}`,
    `drivers: ${drivers.length > 0 ? drivers : '—'}`,
    `brief:   ${s.brief.length > 0 ? s.brief : '—'}`,
    `cached:  ${s.cachedAt}`,
  ];
  if (s.caveats.length > 0) {
    lines.push('');
    lines.push(paint('caveats:', ANSI.bold));
    for (const c of s.caveats) lines.push(`  ! ${c}`);
  }
  return lines.join('\n');
}
