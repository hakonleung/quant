import type { TaAnalysis } from '@quant/shared';
import {
  analyzeManyAction,
  analyzeOneAction,
  analyzeTaAction,
  sectorShowAction,
} from '../actions/registry.js';
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
  subcommands: ['sector', 'ta'],
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

    if (head === 'ta') {
      const second = argv.positional[1];
      // Bare `analyze ta` → guided picker, mirrors bare `analyze`.
      if (second === undefined) {
        return interactive(guidedAnalyzeTa(ctx));
      }
      if (!/^\d{6}$/u.test(second)) {
        return textErr('usage: analyze ta [<code>] [--force]');
      }
      return analyzeTaFlow(ctx, second, force);
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
  theme: string;
  driver: string | null;
  cachedAt: string;
}): string {
  return [
    paint(`${s.code} sentiment`, ANSI.bold, ANSI.cyan),
    `score:    ${formatScore(s.score)}`,
    `theme:    ${s.theme}`,
    `driver:   ${s.driver ?? '—'}`,
    `cachedAt: ${s.cachedAt}`,
  ].join('\n');
}

function formatSentimentDetail(s: {
  code: string;
  score: number;
  theme: string;
  driver: string | null;
  cachedAt: string;
}): string {
  // Detail mode: same fields plus framing prose so the pager has more
  // than five lines to scroll through. This is the read-only document
  // view; production code should pass an LLM-rendered narrative when
  // available (`Sentiment.result` from the API).
  return [
    `# ${s.code} sentiment — detail`,
    '',
    `score    : ${formatScore(s.score)}`,
    `theme    : ${s.theme}`,
    `driver   : ${s.driver ?? '—'}`,
    `cached   : ${s.cachedAt}`,
    '',
    '## Reading',
    '',
    'Brief mode renders the cached summary inline.',
    'Detail mode (this view) shows the same data in a',
    'pageable document. Use j/k or arrows to scroll,',
    'space for one viewport, / to search, q to close.',
  ].join('\n');
}

function formatMarketSentiment(
  s: { codes: readonly string[]; score: number; themes: readonly string[]; cachedAt: string },
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
    `cachedAt: ${s.cachedAt}`,
  ].join('\n');
}

function formatMarketSentimentDetail(
  s: { codes: readonly string[]; score: number; themes: readonly string[]; cachedAt: string },
  label: string,
): string {
  return [
    `# sector ${label} — aggregate sentiment`,
    '',
    `members  : ${String(s.codes.length)}`,
    `score    : ${formatScore(s.score)}`,
    `cached   : ${s.cachedAt}`,
    '',
    '## Themes',
    ...(s.themes.length === 0 ? ['—'] : s.themes.map((t) => `  · ${t}`)),
    '',
    '## Members',
    ...s.codes.map((c) => `  ${c}`),
  ].join('\n');
}

function formatScore(score: number): string {
  if (score > 0.2) return paint(score.toFixed(2), ANSI.green);
  if (score < -0.2) return paint(score.toFixed(2), ANSI.red);
  return paint(score.toFixed(2), ANSI.yellow);
}

// stockListAction is referenced in the picker fallback above only to keep
// the imports honest; remove if a future refactor exposes a metadata-free
// guided picker.
void stockListAction;

// ---------------------------------------------------------------------------
// `analyze ta` — pure price/volume technical analysis (Kimi Pro, beta).
// ---------------------------------------------------------------------------

async function analyzeTaFlow(ctx: Parameters<CommandSpec['run']>[1], code: string, force: boolean) {
  if (force) {
    const widget = confirmPrompt({
      title: `analyze ta ${code}  (Kimi Pro, paid)`,
      body: paint('this will trigger a fresh LLM technical-analysis run', ANSI.gray),
      danger: true,
      onYes: () => ({ kind: 'command', line: `analyze ta ${code}` }),
      onNo: () => canceledResolution,
    });
    return interactive(widget);
  }
  const r = await ctx.actions.run(analyzeTaAction, { code }, { signal: ctx.signal });
  return interactive(
    selectReadingMode({
      title: `analyze ta ${code} — pick reading mode`,
      onPick: (mode) =>
        mode === 'brief'
          ? outputResolution(formatTa(r.data), r.cached ? 'cached' : 'ok')
          : widgetResolution(
              pager({
                title: `analyze ta ${code} (${r.cached ? 'cached' : 'fresh'})`,
                body: formatTaDetail(r.data),
              }),
            ),
    }),
  );
}

function guidedAnalyzeTa(ctx: Parameters<CommandSpec['run']>[1]) {
  // REUSE-CANDIDATE (analyze.ts:104 guidedAnalyze): pick-stock-then-confirm
  // is now used for both `analyze` and `analyze ta`. If a third caller
  // shows up, extract a `pickStockWidget(ctx, onPicked)` helper.
  const items = ctx.stockIndex
    .all()
    .slice(0, 200)
    .map((m) => ({
      code: m.code,
      name: m.name,
      industry: m.industry ?? '',
    }));
  return selectableList({
    title: 'analyze ta: pick stock',
    items,
    columns: [
      { key: 'code', header: 'CODE', max: 8 },
      { key: 'name', header: 'NAME', max: 14 },
      { key: 'industry', header: 'IND', max: 10 },
    ],
    onCommit: (s) =>
      widgetResolution(
        confirmPrompt({
          title: `analyze ta ${String(s.code)} ${String(s.name)}  (Kimi Pro, paid)`,
          danger: true,
          onYes: () => ({ kind: 'command', line: `analyze ta ${String(s.code)} --force` }),
          onNo: () => canceledResolution,
        }),
      ),
  });
}

function formatTa(t: TaAnalysis): string {
  const lines: string[] = [];
  lines.push(
    paint(
      `${t.code} technical analysis (${t.asof}, ${String(t.barsCount)} bars)`,
      ANSI.bold,
      ANSI.cyan,
    ),
  );
  const dirColor =
    t.trend.direction === 'up' ? ANSI.green : t.trend.direction === 'down' ? ANSI.red : ANSI.yellow;
  lines.push(
    `trend:      ${paint(t.trend.direction, dirColor)}  (${String(t.trend.horizonDays)}d, conf=${t.trend.confidence.toFixed(2)})`,
  );
  if (t.trend.rationale.length > 0) lines.push(`rationale:  ${t.trend.rationale}`);
  if (t.resistanceLevels.length > 0) {
    lines.push(paint('resistance:', ANSI.bold));
    for (const lv of t.resistanceLevels) {
      lines.push(`  ${paint(lv.price, ANSI.red)}  [${lv.strength}]  ${lv.reason}`);
    }
  }
  if (t.supportLevels.length > 0) {
    lines.push(paint('support:', ANSI.bold));
    for (const lv of t.supportLevels) {
      lines.push(`  ${paint(lv.price, ANSI.green)}  [${lv.strength}]  ${lv.reason}`);
    }
  }
  if (t.patterns.length > 0) {
    lines.push(`patterns:   ${t.patterns.join(', ')}`);
  }
  for (const c of t.caveats) {
    lines.push(paint(`! ${c}`, ANSI.yellow));
  }
  lines.push(paint(`provider:   ${t.provider || '—'}   cachedAt: ${t.cachedAt}`, ANSI.gray));
  return lines.join('\n');
}

function formatTaDetail(t: TaAnalysis): string {
  const lines: string[] = [];
  lines.push(`# ${t.code} technical analysis`);
  lines.push('');
  lines.push(`asof     : ${t.asof}`);
  lines.push(`bars     : ${String(t.barsCount)}`);
  lines.push(`provider : ${t.provider || '—'}`);
  lines.push(`cached   : ${t.cachedAt}`);
  lines.push('');
  lines.push('## Trend');
  lines.push('');
  lines.push(
    `direction : ${t.trend.direction}  (${String(t.trend.horizonDays)}d, conf=${t.trend.confidence.toFixed(2)})`,
  );
  if (t.trend.rationale.length > 0) {
    lines.push('');
    lines.push('rationale :');
    lines.push(`  ${t.trend.rationale}`);
  }
  lines.push('');
  lines.push('## Resistance levels');
  if (t.resistanceLevels.length === 0) {
    lines.push('—');
  } else {
    for (const lv of t.resistanceLevels) {
      lines.push(`  ${lv.price}  [${lv.strength}]  ${lv.reason}`);
    }
  }
  lines.push('');
  lines.push('## Support levels');
  if (t.supportLevels.length === 0) {
    lines.push('—');
  } else {
    for (const lv of t.supportLevels) {
      lines.push(`  ${lv.price}  [${lv.strength}]  ${lv.reason}`);
    }
  }
  if (t.patterns.length > 0) {
    lines.push('');
    lines.push('## Patterns');
    for (const p of t.patterns) lines.push(`  · ${p}`);
  }
  if (t.caveats.length > 0) {
    lines.push('');
    lines.push('## Caveats');
    for (const c of t.caveats) lines.push(`  ! ${c}`);
  }
  return lines.join('\n');
}
