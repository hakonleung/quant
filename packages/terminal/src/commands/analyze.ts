import { analyzeManyAction, analyzeOneAction, sectorShowAction } from '../actions/registry.js';
import { ANSI, paint } from '../render/ansi.js';
import type { CommandSpec } from '../registry.js';
import { confirmPrompt } from '../widgets/confirm-prompt.js';
import { pager } from '../widgets/pager.js';
import { selectableList } from '../widgets/selectable-list.js';
import { selectReadingMode } from '../widgets/select-reading-mode.js';
import {
  canceledResolution,
  interactive,
  outputResolution,
  textErr,
  widgetResolution,
} from '../widgets/helpers.js';
import { stockListAction } from '../actions/registry.js';

export const analyzeCommand: CommandSpec = {
  name: 'analyze',
  summary: 'Analyze a stock or sector via LLM (paid; cached results free).',
  subcommands: ['sector'],
  complete(positionalIdx, fragment, ctx) {
    if (positionalIdx === 0) {
      return ctx.stockIndex.complete(fragment).map((m) => ({
        insert: m.code,
        label: m.label,
      }));
    }
    return [];
  },
  async run(argv, ctx) {
    const head = argv.positional[0];
    const force = argv.flags['force'] === true || argv.flags['force'] === 'true';

    // Bare `analyze` → guided picker
    if (head === undefined) {
      return interactive(guidedAnalyze(ctx));
    }

    if (head === 'sector') {
      const idOrName = argv.positional[1];
      if (idOrName === undefined) {
        return textErr('usage: analyze sector <id|name> [--force]');
      }
      const sector = await ctx.actions.run(sectorShowAction, { idOrName }, { signal: ctx.signal });
      return analyzeManyConfirm(ctx, sector.data.codes, sector.data.name, force);
    }

    if (!/^\d{6}$/u.test(head)) {
      return textErr(`invalid code: ${head}`);
    }
    return analyzeOneFlow(ctx, head, force);
  },
};

async function analyzeOneFlow(
  ctx: Parameters<CommandSpec['run']>[1],
  code: string,
  force: boolean,
) {
  if (force) {
    // force: confirm widget — bypass reading-mode (no cached output to render)
    const widget = confirmPrompt({
      title: `analyze ${code}  (LLM, paid)`,
      body: paint('this will trigger a fresh LLM request', ANSI.gray),
      danger: true,
      onYes: () => ({
        kind: 'command',
        line: `analyze ${code}`,
      }),
      onNo: () => canceledResolution,
    });
    return interactive(widget);
  }

  const r = await ctx.actions.run(analyzeOneAction, { code }, { signal: ctx.signal });
  return interactive(
    selectReadingMode({
      title: `analyze ${code} — pick reading mode`,
      onPick: (mode) =>
        mode === 'brief'
          ? outputResolution(formatSentiment(r.data), r.cached ? 'cached' : 'ok')
          : widgetResolution(
              pager({
                title: `analyze ${code} (${r.cached ? 'cached' : 'fresh'})`,
                body: formatSentimentDetail(r.data),
              }),
            ),
    }),
  );
}

async function analyzeManyConfirm(
  ctx: Parameters<CommandSpec['run']>[1],
  codes: readonly string[],
  label: string,
  force: boolean,
) {
  if (force) {
    const widget = confirmPrompt({
      title: `analyze sector ${label}  (${String(codes.length)} codes, paid)`,
      danger: true,
      onYes: () => ({ kind: 'command', line: `analyze sector ${label}` }),
      onNo: () => canceledResolution,
    });
    return interactive(widget);
  }
  const r = await ctx.actions.run(analyzeManyAction, { codes }, { signal: ctx.signal });
  return interactive(
    selectReadingMode({
      title: `analyze sector ${label} — pick reading mode`,
      onPick: (mode) =>
        mode === 'brief'
          ? outputResolution(formatMarketSentiment(r.data, label), r.cached ? 'cached' : 'ok')
          : widgetResolution(
              pager({
                title: `analyze sector ${label} (${r.cached ? 'cached' : 'fresh'})`,
                body: formatMarketSentimentDetail(r.data, label),
              }),
            ),
    }),
  );
}

function guidedAnalyze(ctx: Parameters<CommandSpec['run']>[1]) {
  // Quick picker: just stocks for v1 (sector path is reachable via `analyze sector`).
  // We deliberately don't load all 5500 stocks here — use the index.
  const items = ctx.stockIndex
    .all()
    .slice(0, 200)
    .map((m) => ({
      code: m.code,
      name: m.name,
      industry: m.industry ?? '',
    }));
  return selectableList({
    title: 'analyze: pick stock',
    items,
    columns: [
      { key: 'code', header: 'CODE', max: 8 },
      { key: 'name', header: 'NAME', max: 14 },
      { key: 'industry', header: 'IND', max: 10 },
    ],
    onCommit: (s) =>
      widgetResolution(
        confirmPrompt({
          title: `analyze ${String(s.code)} ${String(s.name)}  (LLM, paid)`,
          danger: true,
          onYes: () => ({ kind: 'command', line: `analyze ${String(s.code)} --force` }),
          onNo: () => canceledResolution,
        }),
      ),
  });
}

function formatSentiment(s: {
  code: string;
  score: number;
  brief: string;
  topTheme: string;
  topDriver: string;
  cachedAt: string;
}): string {
  return [
    paint(`${s.code} sentiment`, ANSI.bold, ANSI.cyan),
    `score:    ${formatScore(s.score)}`,
    `theme:    ${s.topTheme.length > 0 ? s.topTheme : '—'}`,
    `driver:   ${s.topDriver.length > 0 ? s.topDriver : '—'}`,
    `brief:    ${s.brief.length > 0 ? s.brief : '—'}`,
    `cachedAt: ${s.cachedAt}`,
  ].join('\n');
}

function formatSentimentDetail(s: {
  code: string;
  score: number;
  brief: string;
  topTheme: string;
  topDriver: string;
  cachedAt: string;
  detail: string;
}): string {
  const header = [
    `# ${s.code} sentiment`,
    '',
    `score    : ${formatScore(s.score)}`,
    `theme    : ${s.topTheme.length > 0 ? s.topTheme : '—'}`,
    `driver   : ${s.topDriver.length > 0 ? s.topDriver : '—'}`,
    `cached   : ${s.cachedAt}`,
    '',
  ];
  if (s.brief.length > 0) header.push('## Brief', '', s.brief, '');
  const body = s.detail.trim();
  if (body.length === 0) {
    return [
      ...header,
      '## detail unavailable',
      '',
      `run \`analyze ${s.code} --force\` to regenerate (paid).`,
    ].join('\n');
  }
  return [...header, '## Full', '', '```', body, '```'].join('\n');
}

function formatMarketSentiment(
  s: { codes: readonly string[]; score: number; themes: readonly string[]; brief: string; cachedAt: string },
  label: string,
): string {
  return [
    paint(
      `sector ${label} aggregate sentiment (${String(s.codes.length)} codes)`,
      ANSI.bold,
      ANSI.cyan,
    ),
    `score:    ${formatScore(s.score)}`,
    `themes:   ${s.themes.join(', ')}`,
    `brief:    ${s.brief.length > 0 ? s.brief : '—'}`,
    `cachedAt: ${s.cachedAt}`,
  ].join('\n');
}

function formatMarketSentimentDetail(
  s: {
    codes: readonly string[];
    score: number;
    themes: readonly string[];
    brief: string;
    cachedAt: string;
    detail: string;
    caveats: readonly string[];
  },
  label: string,
): string {
  const out: string[] = [
    `# sector ${label} — aggregate sentiment`,
    '',
    `members  : ${String(s.codes.length)}`,
    `score    : ${formatScore(s.score)}`,
    `cached   : ${s.cachedAt}`,
    '',
  ];
  if (s.brief.length > 0) out.push('## Brief', '', s.brief, '');
  const body = s.detail.trim();
  if (body.length > 0) {
    out.push('## Full', '', '```', body, '```', '');
  }
  if (s.caveats.length > 0) {
    out.push('## Caveats', ...s.caveats.map((c) => `  ! ${c}`), '');
  }
  out.push('## Members', ...s.codes.map((c) => `  ${c}`));
  return out.join('\n');
}

function formatScore(score: number): string {
  if (score > 0.2) return paint(score.toFixed(2), ANSI.green);
  if (score < -0.2) return paint(score.toFixed(2), ANSI.red);
  return paint(score.toFixed(2), ANSI.yellow);
}

void stockListAction;
