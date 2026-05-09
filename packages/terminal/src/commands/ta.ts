/**
 * `ta` — pure price/volume technical analysis (Kimi Pro, beta).
 *
 * Subcommands:
 *   ta            → guided picker
 *   ta <code>     → single-stock TA (cached unless --force)
 *   ta sector <id|name>
 *                 → fan-out per-stock TA + AI summary, mirrors
 *                   `analyze sector` for sentiment.
 *
 * Extracted from `analyze ta` so the user-facing command surface
 * matches the two distinct LLM pipelines (sentiment vs technical).
 */

import type { TaAnalysis, TaSectorAnalysis } from '@quant/shared';

import {
  analyzeTaAction,
  analyzeTaManyAction,
  sectorShowAction,
  stockListAction,
} from '../actions/registry.js';
import { ANSI, paint } from '../render/ansi.js';
import type { CommandSpec } from '../registry.js';
import { confirmPrompt } from '../widgets/confirm-prompt.js';
import {
  canceledResolution,
  interactive,
  outputResolution,
  textErr,
  widgetResolution,
} from '../widgets/helpers.js';
import { pager } from '../widgets/pager.js';
import { selectableList } from '../widgets/selectable-list.js';
import { selectReadingMode } from '../widgets/select-reading-mode.js';

void stockListAction;

export const taCommand: CommandSpec = {
  name: 'ta',
  summary: 'Technical analysis. `ta <code>` for one stock, `ta sector <id>` for a basket.',
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

    if (head === undefined) {
      return interactive(guidedTa(ctx));
    }

    if (head === 'sector') {
      const idOrName = argv.positional[1];
      if (idOrName === undefined) {
        return textErr('usage: ta sector <id|name> [--force]');
      }
      const sector = await ctx.actions.run(sectorShowAction, { idOrName }, { signal: ctx.signal });
      return taManyConfirm(ctx, sector.data.codes, sector.data.name, force);
    }

    if (!/^\d{6}$/u.test(head)) {
      return textErr(`invalid code: ${head}`);
    }
    return taOneFlow(ctx, head, force);
  },
};

async function taOneFlow(ctx: Parameters<CommandSpec['run']>[1], code: string, force: boolean) {
  if (force) {
    const widget = confirmPrompt({
      title: `ta ${code}  (Kimi Pro, paid)`,
      body: paint('this will trigger a fresh LLM technical-analysis run', ANSI.gray),
      danger: true,
      onYes: () => ({ kind: 'command', line: `ta ${code}` }),
      onNo: () => canceledResolution,
    });
    return interactive(widget);
  }
  const r = await ctx.actions.run(analyzeTaAction, { code }, { signal: ctx.signal });
  return interactive(
    selectReadingMode({
      title: `ta ${code} — pick reading mode`,
      onPick: (mode) =>
        mode === 'brief'
          ? outputResolution(formatTa(r.data), r.cached ? 'cached' : 'ok')
          : widgetResolution(
              pager({
                title: `ta ${code} (${r.cached ? 'cached' : 'fresh'})`,
                body: formatTaDetail(r.data),
              }),
            ),
    }),
  );
}

async function taManyConfirm(
  ctx: Parameters<CommandSpec['run']>[1],
  codes: readonly string[],
  label: string,
  force: boolean,
) {
  if (force) {
    const widget = confirmPrompt({
      title: `ta sector ${label}  (${String(codes.length)} codes, paid)`,
      danger: true,
      onYes: () => ({ kind: 'command', line: `ta sector ${label}` }),
      onNo: () => canceledResolution,
    });
    return interactive(widget);
  }
  const r = await ctx.actions.run(
    analyzeTaManyAction,
    { codes, label },
    { signal: ctx.signal },
  );
  return interactive(
    selectReadingMode({
      title: `ta sector ${label} — pick reading mode`,
      onPick: (mode) =>
        mode === 'brief'
          ? outputResolution(formatTaSector(r.data, label), r.cached ? 'cached' : 'ok')
          : widgetResolution(
              pager({
                title: `ta sector ${label} (${r.cached ? 'cached' : 'fresh'})`,
                body: formatTaSectorDetail(r.data, label),
              }),
            ),
    }),
  );
}

function guidedTa(ctx: Parameters<CommandSpec['run']>[1]) {
  const items = ctx.stockIndex
    .all()
    .slice(0, 200)
    .map((m) => ({
      code: m.code,
      name: m.name,
      industry: m.industry ?? '',
    }));
  return selectableList({
    title: 'ta: pick stock',
    items,
    columns: [
      { key: 'code', header: 'CODE', max: 8 },
      { key: 'name', header: 'NAME', max: 14 },
      { key: 'industry', header: 'IND', max: 10 },
    ],
    onCommit: (s) =>
      widgetResolution(
        confirmPrompt({
          title: `ta ${String(s.code)} ${String(s.name)}  (Kimi Pro, paid)`,
          danger: true,
          onYes: () => ({ kind: 'command', line: `ta ${String(s.code)} --force` }),
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

function formatTaSector(s: TaSectorAnalysis, label: string): string {
  const dirColor =
    s.overallDirection === 'up'
      ? ANSI.green
      : s.overallDirection === 'down'
        ? ANSI.red
        : ANSI.yellow;
  return [
    paint(
      `sector ${label} technical analysis (${String(s.codes.length)} codes)`,
      ANSI.bold,
      ANSI.cyan,
    ),
    `direction : ${paint(s.overallDirection, dirColor)}  (avg conf=${s.overallConfidence.toFixed(2)})`,
    `breakdown : up ${String(s.trendBreakdown.up)} / down ${String(s.trendBreakdown.down)} / sideways ${String(s.trendBreakdown.sideways)}`,
    `cachedAt  : ${s.cachedAt}`,
  ].join('\n');
}

function formatTaSectorDetail(s: TaSectorAnalysis, label: string): string {
  const out: string[] = [
    `# sector ${label} — technical analysis`,
    '',
    `members  : ${String(s.codes.length)}`,
    `direction: ${s.overallDirection}  (avg conf=${s.overallConfidence.toFixed(2)})`,
    `cached   : ${s.cachedAt}`,
    '',
    '## Trend distribution',
    '',
    `up       : ${String(s.trendBreakdown.up)}`,
    `down     : ${String(s.trendBreakdown.down)}`,
    `sideways : ${String(s.trendBreakdown.sideways)}`,
    '',
  ];
  if (s.summary.trim().length > 0) {
    out.push('## Summary', '', s.summary.trim(), '');
  }
  out.push('## Members');
  for (const m of s.members) {
    out.push(
      `  ${m.code}  ${m.trend.direction.padEnd(8)}  conf=${m.trend.confidence.toFixed(2)}  R:${m.keyResistance ?? '—'}  S:${m.keySupport ?? '—'}`,
    );
  }
  if (s.caveats.length > 0) {
    out.push('', '## Caveats');
    for (const c of s.caveats) out.push(`  ! ${c}`);
  }
  return out.join('\n');
}
