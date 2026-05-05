import {
  stockInfoAction,
  stockKlineAction,
  stockSnapshotsAction,
} from '../actions/registry.js';
import { ANSI, paint } from '../render/ansi.js';
import { sparkline } from '../render/sparkline.js';
import { renderTable } from '../render/table.js';
import type { CommandSpec } from '../registry.js';
import { selectableList } from '../widgets/selectable-list.js';
import { interactive, textCached, textErr, textOk } from '../widgets/helpers.js';

export const stockCommand: CommandSpec = {
  name: 'stock',
  summary: 'Stock lookup. Subcommands: find <fragment>, info <code>, kline <code>.',
  subcommands: ['find', 'info', 'kline'],
  complete(positionalIdx, fragment, ctx) {
    if (positionalIdx === 1) {
      return ctx.stockIndex.complete(fragment).map((m) => ({
        insert: m.code,
        label: m.label,
      }));
    }
    return [];
  },
  async run(argv, ctx) {
    const sub = argv.positional[0];
    if (sub === undefined) {
      return textErr('stock: missing subcommand (find / info / kline)');
    }
    if (sub === 'find') return runFind(argv, ctx);
    if (sub === 'info') return runInfo(argv, ctx);
    if (sub === 'kline') return runKline(argv, ctx);
    return textErr(`stock: unknown subcommand ${sub}`);
  },
};

async function runFind(argv: { positional: readonly string[] }, ctx: Parameters<CommandSpec['run']>[1]) {
  const fragment = argv.positional[1];
  if (fragment === undefined || fragment.length === 0) {
    return textErr('usage: stock find <fragment>');
  }
  const matches = ctx.stockIndex.complete(fragment, 50);
  if (matches.length === 0) {
    return textOk(`no matches for "${fragment}"`);
  }
  const items = matches.map((m) => {
    const meta = ctx.stockIndex.byCode(m.code);
    return {
      code: m.code,
      name: m.name,
      industry: meta?.industry ?? '',
    };
  });
  const widget = selectableList({
    title: `stock find: ${fragment}`,
    items,
    columns: [
      { key: 'code', header: 'CODE', max: 8 },
      { key: 'name', header: 'NAME', max: 14 },
      { key: 'industry', header: 'IND', max: 10 },
    ],
    onCommit: (s) => ({ kind: 'command', line: `stock info ${String(s.code)}` }),
    extraKeys: [
      {
        key: 'a',
        hint: { keys: ['a'], label: 'analyze (paid)', danger: true },
        resolve: (s) => ({ kind: 'command', line: `analyze ${String(s.code)}` }),
      },
      {
        key: 'f',
        hint: { keys: ['f'], label: 'focus' },
        resolve: (s) => ({ kind: 'command', line: `focus ${String(s.code)}` }),
      },
    ],
  });
  return interactive(widget);
}

async function runInfo(argv: { positional: readonly string[] }, ctx: Parameters<CommandSpec['run']>[1]) {
  const code = argv.positional[1];
  if (code === undefined) return textErr('usage: stock info <code>');
  const meta = await ctx.actions.run(stockInfoAction, { code }, { signal: ctx.signal });
  const snaps = await ctx.actions.run(
    stockSnapshotsAction,
    { codes: [code] },
    { signal: ctx.signal },
  );
  const klineRes = await ctx.actions.run(
    stockKlineAction,
    { code, range: '30D' },
    { signal: ctx.signal },
  );
  const snap = snaps.data[0];
  const last = klineRes.data.at(-1);
  const lines: string[] = [];
  lines.push(paint(`${meta.data.code}  ${meta.data.name}`, ANSI.bold, ANSI.cyan));
  lines.push(`industry: ${meta.data.industry ?? '—'}    market: ${meta.data.market}`);
  if (snap !== undefined) {
    lines.push(
      `price: ${String(snap.price ?? '—')}    pe_ttm: ${String(snap.pe_ttm ?? '—')}    pb: ${String(snap.pb ?? '—')}`,
    );
  }
  if (last !== undefined) {
    lines.push(`asof: ${last.date}    O ${String(last.open)} H ${String(last.high)} L ${String(last.low)} C ${String(last.close)}`);
  }
  lines.push(paint(sparkline(klineRes.data.map((b) => b.close)), ANSI.cyan));
  const cached = meta.cached && snaps.cached && klineRes.cached;
  return cached ? textCached(lines.join('\n')) : textOk(lines.join('\n'));
}

async function runKline(argv: { positional: readonly string[]; flags: Readonly<Record<string, string | boolean>> }, ctx: Parameters<CommandSpec['run']>[1]) {
  const code = argv.positional[1];
  if (code === undefined) return textErr('usage: stock kline <code> [--range=30D|90D|250D]');
  const rangeRaw = argv.flags['range'];
  const range = (typeof rangeRaw === 'string' ? rangeRaw : '30D') as '30D' | '90D' | '250D';
  const r = await ctx.actions.run(stockKlineAction, { code, range }, { signal: ctx.signal });
  const last5 = r.data.slice(-5).map((b) => ({
    date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
  const lines = [
    paint(`${code} kline ${range}  bars=${String(r.data.length)}`, ANSI.bold, ANSI.cyan),
    paint(sparkline(r.data.map((b) => b.close)), ANSI.cyan),
    renderTable(last5, [
      { key: 'date', header: 'DATE', max: 10 },
      { key: 'open', header: 'O', align: 'right' },
      { key: 'high', header: 'H', align: 'right' },
      { key: 'low', header: 'L', align: 'right' },
      { key: 'close', header: 'C', align: 'right' },
    ]),
  ];
  return r.cached ? textCached(lines.join('\n')) : textOk(lines.join('\n'));
}
