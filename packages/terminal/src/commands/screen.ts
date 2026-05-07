import { screenNlAction, sectorUpsertAction, type Sector } from '../actions/registry.js';
import type { CommandSpec } from '../registry.js';
import { confirmPrompt } from '../widgets/confirm-prompt.js';
import { selectableList } from '../widgets/selectable-list.js';
import {
  canceledResolution,
  interactive,
  outputResolution,
  textErr,
  widgetResolution,
} from '../widgets/helpers.js';

/**
 * Two-phase NL screen:
 *
 *   1. `screen nl <text>` shows a danger confirm. YES re-submits the same
 *      command line with `--confirmed`; NO collapses to "canceled".
 *
 *   2. `screen nl <text> --confirmed` runs the action and returns the
 *      results widget. Because this is a fresh submit the engine is in
 *      `running` phase while the fetch is in flight, so the bridge's
 *      spinner footer naturally covers latency. When the action resolves,
 *      the dispatcher transitions to `interactive` with the matches list.
 *
 * The previous "loader-widget polls for cached fetch" pattern got stuck
 * because pure widgets have no way to wake themselves once the underlying
 * promise resolved.
 */
export const screenCommand: CommandSpec = {
  name: 'screen',
  summary: 'NL screening. Subcommand: nl <text>.',
  subcommands: ['nl'],
  async run(argv, ctx) {
    const sub = argv.positional[0];
    if (sub !== 'nl') return textErr('usage: screen nl <text>');
    const nl = argv.positional.slice(1).join(' ').trim();
    if (nl.length === 0) return textErr('usage: screen nl <text>');

    if (argv.flags['confirmed'] !== true) {
      return interactive(
        confirmPrompt({
          title: `screen nl: "${nl}" (paid)`,
          danger: true,
          onYes: () => ({ kind: 'command', line: `screen nl ${nl} --confirmed` }),
          onNo: () => canceledResolution,
        }),
      );
    }

    const r = await ctx.actions.run(screenNlAction, { nl }, { signal: ctx.signal });
    return interactive(
      buildMatchesList(ctx, nl, {
        matches: r.data.matches.map((m) => ({
          code: m.code,
          name: m.name,
          score: m.score ?? null,
        })),
        dslSummary: r.data.dslSummary,
      }),
    );
  },
};

function buildMatchesList(
  ctx: Parameters<CommandSpec['run']>[1],
  nl: string,
  data: { matches: { code: string; name: string; score: number | null }[]; dslSummary: string },
) {
  const items = data.matches.map((m) => ({
    code: m.code,
    name: m.name,
    score: m.score ?? 0,
  }));
  return selectableList({
    title: `screen "${nl}"  ·  ${data.dslSummary}`,
    items,
    columns: [
      { key: 'code', header: 'CODE', max: 8 },
      { key: 'name', header: 'NAME', max: 14 },
      { key: 'score', header: 'SCORE', align: 'right' },
    ],
    onCommit: (s) => ({ kind: 'command', line: `stock info ${String(s.code)}` }),
    extraKeys: [
      {
        key: 's',
        hint: { keys: ['s'], label: 'save as dynamic sector' },
        resolve: () =>
          widgetResolution(
            saveAsSector(
              ctx,
              nl,
              items.map((i) => i.code),
            ),
          ),
      },
    ],
  });
}

function saveAsSector(
  ctx: Parameters<CommandSpec['run']>[1],
  nl: string,
  codes: readonly string[],
) {
  return confirmPrompt({
    title: `save dynamic sector from screen (${String(codes.length)} codes)?`,
    onYes: () => {
      const id = `screen-${String(Date.now())}`;
      const sector: Sector = {
        id,
        name: nl.slice(0, 24),
        kind: 'dynamic',
        count: codes.length,
        meta: nl,
        chgPct: null,
        codes: [...codes],
        nl,
      };
      void ctx.actions.run(sectorUpsertAction, { sector }, { signal: ctx.signal });
      return outputResolution(
        `saved dynamic sector "${sector.name}" (${String(codes.length)} codes)`,
        'ok',
      );
    },
    onNo: () => canceledResolution,
  });
}
