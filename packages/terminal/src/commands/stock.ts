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

/**
 * `stock`              — open the universe picker (filterable list).
 * `stock info [code]`  — show one stock's details. Without a code, opens
 *                         the picker; pressing Enter on a row dispatches
 *                         `stock info <code>`.
 * `stock kline [code]` — same shape as info; Enter dispatches
 *                         `stock kline <code>`. `--range` is preserved.
 *
 * `stock find` was removed — filtering inside the picker covers the same
 * use case without having to remember an extra subcommand.
 */
export const stockCommand: CommandSpec = {
  name: 'stock',
  summary: 'Stock lookup. Subcommands: info [code], kline [code]. No subcmd → universe picker.',
  subcommands: ['info', 'kline'],
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
    if (sub === undefined) return openPicker(ctx, 'info');
    if (sub === 'info') {
      const code = argv.positional[1];
      if (code === undefined) return openPicker(ctx, 'info');
      return runInfo(code, ctx);
    }
    if (sub === 'kline') {
      const code = argv.positional[1];
      const rangeRaw = argv.flags['range'];
      const range = (typeof rangeRaw === 'string' ? rangeRaw : '30D') as '30D' | '90D' | '250D';
      if (code === undefined) return openPicker(ctx, 'kline', range);
      return runKline(code, range, ctx);
    }
    return textErr(`stock: unknown subcommand ${sub}`);
  },
};

function openPicker(
  ctx: Parameters<CommandSpec['run']>[1],
  action: 'info' | 'kline',
  range: '30D' | '90D' | '250D' = '30D',
) {
  const items = ctx.stockIndex.all().map((m) => ({
    code: m.code,
    name: m.name,
    industry: m.industry ?? '',
  }));
  if (items.length === 0) {
    return textOk(paint('stock universe is empty — preload running?', ANSI.gray));
  }
  const trailingArgs = action === 'kline' ? ` --range=${range}` : '';
  return interactive(
    selectableList({
      title: `stock ${action} — pick (filter with /)`,
      items,
      columns: [
        { key: 'code', header: 'CODE', max: 8 },
        { key: 'name', header: 'NAME', max: 14 },
        { key: 'industry', header: 'IND', max: 12 },
      ],
      onCommit: (s) => ({ kind: 'command', line: `stock ${action} ${String(s.code)}${trailingArgs}` }),
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
    }),
  );
}

async function runInfo(code: string, ctx: Parameters<CommandSpec['run']>[1]) {
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
  const rows: { k: string; v: string }[] = [];
  rows.push({ k: 'industry', v: meta.data.industry ?? '—' });
  rows.push({ k: 'market', v: meta.data.market });
  if (snap !== undefined) {
    rows.push({ k: 'price', v: String(snap.price ?? '—') });
    rows.push({ k: 'pe_ttm', v: String(snap.pe_ttm ?? '—') });
    rows.push({ k: 'pb', v: String(snap.pb ?? '—') });
  }
  if (last !== undefined) {
    rows.push({ k: 'asof', v: last.date });
    rows.push({ k: 'O / H / L / C', v: `${String(last.open)} / ${String(last.high)} / ${String(last.low)} / ${String(last.close)}` });
  }
  const lines: string[] = [];
  lines.push(paint(`${meta.data.code}  ${meta.data.name}`, ANSI.bold, ANSI.cyan));
  lines.push(
    renderTable(rows, [
      { key: 'k', header: 'FIELD', max: 14 },
      { key: 'v', header: 'VALUE', max: 40 },
    ]),
  );
  lines.push(paint(sparkline(klineRes.data.map((b) => b.close)), ANSI.cyan));
  const cached = meta.cached && snaps.cached && klineRes.cached;
  return cached ? textCached(lines.join('\n')) : textOk(lines.join('\n'));
}

async function runKline(
  code: string,
  range: '30D' | '90D' | '250D',
  ctx: Parameters<CommandSpec['run']>[1],
) {
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
