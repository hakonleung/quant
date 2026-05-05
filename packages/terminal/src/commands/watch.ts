import {
  watchListAction,
  watchRemoveAction,
  watchUpsertAction,
  type WatchTask,
} from '../actions/registry.js';
import { ANSI, paint } from '../render/ansi.js';
import type { CommandSpec } from '../registry.js';
import { confirmPrompt } from '../widgets/confirm-prompt.js';
import { formPrompt } from '../widgets/form-prompt.js';
import { selectableList } from '../widgets/selectable-list.js';
import {
  interactive,
  outputResolution,
  textErr,
  textOk,
  widgetResolution,
} from '../widgets/helpers.js';

export const watchCommand: CommandSpec = {
  name: 'watch',
  summary: 'Watch tasks. Subcommands: list, add, rm.',
  subcommands: ['list', 'add', 'rm'],
  async run(argv, ctx) {
    const sub = argv.positional[0];
    if (sub === undefined) return textErr('watch: missing subcommand (list/add/rm)');
    if (sub === 'list') return runList(ctx);
    if (sub === 'add') return runAdd(argv, ctx);
    if (sub === 'rm') return runRemove(argv, ctx);
    return textErr(`watch: unknown subcommand ${sub}`);
  },
};

async function runList(ctx: Parameters<CommandSpec['run']>[1]) {
  const r = await ctx.actions.run(watchListAction, {}, { signal: ctx.signal });
  if (r.data.length === 0) {
    return textOk(paint('no watch tasks — try `watch add`', ANSI.gray));
  }
  const items = r.data.map((t) => ({
    market: t.market,
    code: t.code,
    name: t.name,
    kind: t.kind,
    threshold: t.kind === 'pct' ? `${String(t.thresholdPct ?? 0)}%` : String(t.thresholdPrice ?? '—'),
    intervalSec: t.intervalSec,
    hits: t.hitCount,
  }));
  const widget = selectableList({
    title: 'watch tasks',
    items,
    columns: [
      { key: 'market', header: 'MKT', max: 4 },
      { key: 'code', header: 'CODE', max: 8 },
      { key: 'name', header: 'NAME', max: 14 },
      { key: 'kind', header: 'K', max: 4 },
      { key: 'threshold', header: 'THR', max: 8, align: 'right' },
      { key: 'intervalSec', header: 'IVL', align: 'right' },
      { key: 'hits', header: 'HIT', align: 'right' },
    ],
    onCommit: (s) => ({ kind: 'command', line: `stock info ${String(s.code)}` }),
    extraKeys: [
      {
        key: 'd',
        hint: { keys: ['d'], label: 'delete', danger: true },
        resolve: (s) => widgetResolution(
          confirmPrompt({
            title: `delete watch ${String(s.market)}/${String(s.code)}?`,
            danger: true,
            onYes: () => ({
              kind: 'command',
              line: `watch rm ${String(s.market)} ${String(s.code)}`,
            }),
            onNo: () => outputResolution('cancelled', 'info'),
          }),
        ),
      },
    ],
  });
  return interactive(widget);
}

async function runAdd(argv: { positional: readonly string[]; flags: Readonly<Record<string, string | boolean>> }, ctx: Parameters<CommandSpec['run']>[1]) {
  // Short form: `watch add --market=a --code=600519 --pct=3`
  const market = argv.flags['market'];
  const code = argv.flags['code'];
  const pct = argv.flags['pct'];
  if (typeof market === 'string' && typeof code === 'string') {
    const meta = ctx.stockIndex.byCode(code);
    const task: WatchTask = {
      market: market as 'a' | 'hk' | 'us',
      code,
      name: meta?.name ?? code,
      kind: 'pct',
      thresholdPct: typeof pct === 'string' ? Number.parseFloat(pct) : 3,
      thresholdPrice: null,
      intervalSec: 30,
      enabled: true,
      hitCount: 0,
    };
    await ctx.actions.run(watchUpsertAction, { task }, { signal: ctx.signal });
    return textOk(`watch task created: ${market}/${code} (pct ±${String(task.thresholdPct ?? 3)}%)`);
  }
  // Guided
  return interactive(
    formPrompt({
      title: 'watch add',
      fields: [
        { key: 'market', label: 'market', kind: 'enum', options: ['a', 'hk', 'us'], initial: 'a' },
        {
          key: 'code',
          label: 'code',
          kind: 'search',
          placeholder: 'type code / name / pinyin',
          search: (q) =>
            ctx.stockIndex.complete(q, 6).map((m) => ({
              value: m.code,
              label: m.label,
            })),
          validate: (v) => (/^\d{6}$/u.test(v) ? null : 'must be 6 digits'),
        },
        { key: 'kind', label: 'kind', kind: 'enum', options: ['pct', 'abs'], initial: 'pct' },
        { key: 'threshold', label: 'threshold', kind: 'number', initial: '3' },
        { key: 'intervalSec', label: 'intervalSec', kind: 'number', initial: '30' },
      ],
      onSubmit: (v) => {
        const meta = ctx.stockIndex.byCode(v['code'] ?? '');
        const kind = v['kind'] === 'abs' ? 'abs' : 'pct';
        const threshold = Number.parseFloat(v['threshold'] ?? '0');
        const intervalSec = Math.max(1, Math.floor(Number.parseFloat(v['intervalSec'] ?? '30')));
        const task: WatchTask = {
          market: (v['market'] ?? 'a') as 'a' | 'hk' | 'us',
          code: v['code'] ?? '',
          name: meta?.name ?? (v['code'] ?? ''),
          kind,
          thresholdPct: kind === 'pct' ? threshold : null,
          thresholdPrice: kind === 'abs' ? threshold : null,
          intervalSec,
          enabled: true,
          hitCount: 0,
        };
        return widgetResolution(
          confirmPrompt({
            title: `create watch ${task.market}/${task.code} (${task.kind} ${String(threshold)})?`,
            onYes: () => {
              void ctx.actions.run(watchUpsertAction, { task }, { signal: ctx.signal });
              return outputResolution(`watch task created: ${task.market}/${task.code}`, 'ok');
            },
            onNo: () => outputResolution('cancelled', 'info'),
          }),
        );
      },
    }),
  );
}

async function runRemove(argv: { positional: readonly string[] }, ctx: Parameters<CommandSpec['run']>[1]) {
  const market = argv.positional[1];
  const code = argv.positional[2];
  if (market === undefined || code === undefined) {
    return textErr('usage: watch rm <market> <code>');
  }
  await ctx.actions.run(
    watchRemoveAction,
    { market: market as 'a' | 'hk' | 'us', code },
    { signal: ctx.signal },
  );
  return textOk(`removed watch ${market}/${code}`);
}
