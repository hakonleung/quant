import {
  screenNlAction,
  sectorUpsertAction,
  type Sector,
} from '../actions/registry.js';
import type { CommandSpec } from '../registry.js';
import { confirmPrompt } from '../widgets/confirm-prompt.js';
import { selectableList } from '../widgets/selectable-list.js';
import {
  interactive,
  outputResolution,
  textErr,
  widgetResolution,
} from '../widgets/helpers.js';

export const screenCommand: CommandSpec = {
  name: 'screen',
  summary: 'NL screening. Subcommand: nl <text>.',
  subcommands: ['nl'],
  async run(argv, ctx) {
    const sub = argv.positional[0];
    if (sub !== 'nl') return textErr('usage: screen nl <text>');
    const nl = argv.positional.slice(1).join(' ');
    if (nl.length === 0) return textErr('usage: screen nl <text>');
    return interactive(
      confirmPrompt({
        title: `screen nl: "${nl}" (paid)`,
        danger: true,
        onYes: () => widgetResolution(loaderShim(ctx, nl)),
        onNo: () => outputResolution('cancelled', 'info'),
      }),
    );
  },
};

/**
 * Build a SelectableList of NL screen matches. The screen action is
 * pre-fetched here (the dispatcher resolves widget chains in an async
 * context, so awaiting here is safe). For the mock runner this resolves
 * within milliseconds; the live runner will surface latency naturally.
 */
function loaderShim(ctx: Parameters<CommandSpec['run']>[1], nl: string) {
  // We can't await here because we need to return a widget synchronously.
  // Instead, we use a thin "resolver-on-first-key" trick: the widget
  // immediately resolves to a chained widget on its first state update,
  // populated with results.
  return resultsPlaceholder(ctx, nl);
}

function resultsPlaceholder(ctx: Parameters<CommandSpec['run']>[1], nl: string) {
  let cached: Awaited<ReturnType<typeof ctx.actions.run>> | null = null;
  let pending: Promise<void> | null = null;

  const ensure = async (): Promise<void> => {
    if (cached !== null || pending !== null) return pending ?? Promise.resolve();
    pending = (async (): Promise<void> => {
      cached = await ctx.actions.run(screenNlAction, { nl }, { signal: ctx.signal });
    })();
    return pending;
  };

  // Kick off the fetch but don't block widget construction.
  void ensure();

  return {
    title: `screen results: ${nl}`,
    initialState: { tick: 0 },
    hints: () => [
      { keys: ['Enter'], label: 'open list when ready' },
      { keys: ['Esc'], label: 'cancel' },
    ],
    render: () => {
      if (cached === null) return 'fetching…';
      return `${String((cached.data as { matches: unknown[] }).matches.length)} matches — press Enter`;
    },
    snapshot: () => `screen ${nl} → ${cached === null ? '?' : String((cached.data as { matches: unknown[] }).matches.length)} matches`,
    handleKey: (s: { tick: number }, key: { special?: string }) => {
      if (key.special === 'Enter' && cached !== null) {
        const data = cached.data as {
          matches: { code: string; name: string; score: number | null }[];
          dslSummary: string;
        };
        return {
          kind: 'submit' as const,
          result: widgetResolution(buildMatchesList(ctx, nl, data)),
        };
      }
      return { kind: 'state' as const, next: s };
    },
    commit: (resolution: ReturnType<typeof widgetResolution>) => resolution,
  };
}

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
        resolve: () => widgetResolution(saveAsSector(ctx, nl, items.map((i) => i.code))),
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
      return outputResolution(`saved dynamic sector "${sector.name}" (${String(codes.length)} codes)`, 'ok');
    },
    onNo: () => outputResolution('cancelled', 'info'),
  });
}
