import { isValidWatchCode, type WatchMarket } from '@quant/shared';

import {
  watchGroupToggleAction,
  watchListAction,
  watchRemoveAction,
  watchUpsertAction,
  type WatchBaseline,
  type WatchCondition,
  type WatchOp,
  type WatchTask,
} from '../actions/registry.js';
import { ANSI, paint } from '../render/ansi.js';
import type { CommandSpec } from '../registry.js';
import { confirmPrompt } from '../widgets/confirm-prompt.js';
import { formPrompt } from '../widgets/form-prompt.js';
import { selectableList } from '../widgets/selectable-list.js';
import {
  canceledResolution,
  interactive,
  outputResolution,
  textErr,
  textOk,
  widgetResolution,
} from '../widgets/helpers.js';

const MARKETS: readonly WatchMarket[] = ['a', 'hk', 'us'];
const BASELINES: readonly WatchBaseline[] = ['prev_close', 'day_high', 'day_low', 'vwap', 'trend'];
const OPS: readonly WatchOp[] = ['gte', 'lte'];
/** Default lookback for the `trend` baseline (seconds). */
const DEFAULT_TREND_WINDOW_SEC = 60;

function currencySuffix(market: WatchMarket): string {
  if (market === 'us') return 'USD';
  if (market === 'hk') return 'HKD';
  return 'CNY';
}

/** Render a per-market code-shape hint for placeholders / errors. */
function codeHint(market: WatchMarket): string {
  switch (market) {
    case 'a':
      return '6 digits (e.g. 600519)';
    case 'hk':
      return '4–5 digits (e.g. 00700)';
    case 'us':
      return 'letters, optional secid prefix (e.g. AAPL, 105.LITE)';
  }
}

function isWatchMarket(s: string): s is WatchMarket {
  return (MARKETS as readonly string[]).includes(s);
}

export const watchCommand: CommandSpec = {
  name: 'watch',
  summary: 'Watch tasks. Subcommands: list, add, rm, group.',
  subcommands: ['list', 'add', 'rm', 'group'],
  async run(argv, ctx) {
    const sub = argv.positional[0];
    if (sub === undefined) return textErr('watch: missing subcommand (list/add/rm/group)');
    if (sub === 'list') return runList(ctx);
    if (sub === 'add') return runAdd(ctx);
    if (sub === 'rm') return runRemove(argv, ctx);
    if (sub === 'group') return runGroup(argv, ctx);
    return textErr(`watch: unknown subcommand ${sub}`);
  },
};

function describeCondition(
  c: WatchCondition,
  market: 'a' | 'hk' | 'us',
): { kind: string; base: string; op: string; value: string } {
  if (c.kind === 'pct') {
    return {
      kind: 'pct',
      base: c.baseline,
      op: c.op === 'gte' ? '≥' : '≤',
      value: `${c.thresholdPct}%`,
    };
  }
  if (c.kind === 'abs') {
    return {
      kind: 'abs',
      base: '—',
      op: c.op === 'gte' ? '≥' : '≤',
      value: `${c.thresholdPrice} ${currencySuffix(market)}`,
    };
  }
  return {
    kind: 'ma',
    base: c.indicator,
    op: c.op === 'crossUp' ? '↑' : '↓',
    value: c.op,
  };
}

async function runList(ctx: Parameters<CommandSpec['run']>[1]) {
  const r = await ctx.actions.run(watchListAction, {}, { signal: ctx.signal });
  if (r.data.length === 0) {
    return textOk(paint('no watch tasks — try `watch add`', ANSI.gray));
  }
  const items = r.data.map((t) => {
    const first = t.conditions[0];
    const cond =
      first !== undefined
        ? describeCondition(first, t.market)
        : { kind: '—', base: '—', op: '—', value: '—' };
    const more = t.conditions.length > 1 ? ` +${String(t.conditions.length - 1)}` : '';
    return {
      market: t.market,
      code: t.code,
      name: t.name,
      kind: cond.kind,
      base: cond.base,
      op: cond.op,
      value: `${cond.value}${more}`,
      intervalMin: `${String(Math.round(t.intervalSec / 60))}min`,
      pushMin: `${String(Math.round(t.pushIntervalSec / 60))}min`,
      hits: t.hitCount,
    };
  });
  const widget = selectableList({
    title: 'watch tasks',
    items,
    columns: [
      { key: 'market', header: 'MKT', max: 4 },
      { key: 'code', header: 'CODE', max: 8 },
      { key: 'name', header: 'NAME', max: 12 },
      { key: 'kind', header: 'KIND', max: 4 },
      { key: 'base', header: 'BASE', max: 10 },
      { key: 'op', header: 'OP', max: 3 },
      { key: 'value', header: 'VALUE', max: 10, align: 'right' },
      { key: 'intervalMin', header: 'IVL', align: 'right' },
      { key: 'pushMin', header: 'PUSH', align: 'right' },
      { key: 'hits', header: 'HIT', align: 'right' },
    ],
    onCommit: (s) => ({ kind: 'command', line: `stock info ${String(s.code)}` }),
    extraKeys: [
      {
        key: 'd',
        hint: { keys: ['d'], label: 'delete', danger: true },
        resolve: (s) =>
          widgetResolution(
            confirmPrompt({
              title: `delete watch ${String(s.market)}/${String(s.code)}?`,
              danger: true,
              onYes: () => ({
                kind: 'command',
                line: `watch rm ${String(s.market)} ${String(s.code)}`,
              }),
              onNo: () => canceledResolution,
            }),
          ),
      },
    ],
  });
  return interactive(widget);
}

/**
 * Guided `watch add` — fields aligned with the project schema:
 *   market | code | kind | baseline | op | value | interval (min)
 *
 * Up/Down switches between fields; Left/Right cycles options inside the
 * active enum field; printable chars edit text/number fields.
 */
function runAdd(ctx: Parameters<CommandSpec['run']>[1]) {
  return interactive(
    formPrompt({
      title: 'watch add',
      fields: [
        { key: 'market', label: 'market', kind: 'enum', options: [...MARKETS], initial: 'a' },
        {
          key: 'code',
          label: 'code',
          kind: 'search',
          placeholder: 'type code / name / pinyin (A: 6 digits · HK: 4–5 · US: letters)',
          // The cached stockIndex covers the A-share universe only — for
          // hk / us we still surface the input as a free-text candidate
          // so the user can type a code directly. Strict per-market
          // validation runs at submit time against shared
          // `isValidWatchCode`.
          search: (q) => {
            if (q.length === 0) return [];
            const aHits = ctx.stockIndex.complete(q, 6).map((m) => ({
              value: m.code,
              label: m.label,
            }));
            return aHits.length > 0 ? aHits : [{ value: q, label: q }];
          },
          // Field-local validator stays lenient (just non-empty) — we
          // don't know the selected market here. Real per-market
          // validation happens at onSubmit using shared
          // `isValidWatchCode`.
          validate: (v) => (v.trim().length === 0 ? 'code is required' : null),
        },
        { key: 'kind', label: 'kind', kind: 'enum', options: ['pct', 'abs'], initial: 'pct' },
        {
          key: 'baseline',
          label: 'baseline',
          kind: 'enum',
          options: [...BASELINES],
          initial: 'prev_close',
        },
        { key: 'op', label: 'op', kind: 'enum', options: [...OPS], initial: 'gte' },
        {
          key: 'value',
          label: 'value',
          kind: 'number',
          initial: '5',
          placeholder: '% (pct) or price (abs)',
          suffix: (v) =>
            v['kind'] === 'abs' ? currencySuffix((v['market'] ?? 'a') as 'a' | 'hk' | 'us') : '%',
        },
        {
          // Only consumed when baseline === 'trend'; the suffix hides it
          // visually for the other baselines so the row reads as inert.
          key: 'windowSec',
          label: 'window',
          kind: 'number',
          initial: String(DEFAULT_TREND_WINDOW_SEC),
          suffix: (v) => (v['baseline'] === 'trend' ? 's' : '— (only for trend)'),
        },
        {
          key: 'intervalMin',
          label: 'interval (min)',
          kind: 'number',
          initial: '1',
          suffix: () => 'min',
        },
        {
          key: 'pushMin',
          label: 'push (min)',
          kind: 'number',
          initial: '5',
          suffix: () => 'min',
        },
      ],
      onSubmit: (v) => {
        const market: WatchMarket = isWatchMarket(v['market'] ?? '')
          ? (v['market'] as WatchMarket)
          : 'a';
        const code = (v['code'] ?? '').trim();
        if (!isValidWatchCode(market, code)) {
          return outputResolution(
            `code "${code}" is not valid for market ${market} — expected ${codeHint(market)}`,
            'err',
          );
        }
        const meta = ctx.stockIndex.byCode(code);
        const kind = v['kind'] === 'abs' ? 'abs' : 'pct';
        const value = (v['value'] ?? '').trim();
        if (value.length === 0 || !/^-?\d+(\.\d+)?$/u.test(value)) {
          return outputResolution('value must be a decimal number', 'err');
        }
        if (kind === 'abs' && Number(value) <= 0) {
          return outputResolution('abs value must be > 0', 'err');
        }
        if (kind === 'pct' && Number(value) === 0) {
          return outputResolution('pct value must be non-zero', 'err');
        }
        const intervalMin = Number.parseFloat(v['intervalMin'] ?? '1');
        const intervalSec = Math.max(5, Math.round(intervalMin * 60));
        const pushMin = Number.parseFloat(v['pushMin'] ?? '5');
        const pushIntervalSec = Math.max(60, Math.round(pushMin * 60));
        const op = (v['op'] === 'lte' ? 'lte' : 'gte') satisfies WatchOp;
        const baseline = (BASELINES as readonly string[]).includes(v['baseline'] ?? '')
          ? (v['baseline'] as WatchBaseline)
          : 'prev_close';
        const windowSecRaw = Number.parseInt(v['windowSec'] ?? '', 10);
        const windowSec = Number.isFinite(windowSecRaw)
          ? Math.max(1, Math.min(4 * 60 * 60, windowSecRaw))
          : DEFAULT_TREND_WINDOW_SEC;
        const condition: WatchCondition =
          kind === 'pct'
            ? baseline === 'trend'
              ? {
                  kind: 'pct',
                  baseline,
                  op,
                  thresholdPct: value,
                  window: windowSec,
                }
              : {
                  kind: 'pct',
                  baseline,
                  op,
                  thresholdPct: value,
                }
            : { kind: 'abs', op, thresholdPrice: value };
        const task: WatchTask = {
          market,
          code,
          name: meta?.name ?? code,
          conditions: [condition],
          intervalSec,
          pushIntervalSec,
          enabled: true,
          hitCount: 0,
        };
        const desc = describeCondition(condition, task.market);
        return widgetResolution(
          confirmPrompt({
            title: `create watch ${task.market}/${task.code} (${desc.kind} ${desc.base} ${desc.op} ${desc.value})?`,
            onYes: () => {
              void ctx.actions.run(watchUpsertAction, { task }, { signal: ctx.signal });
              return outputResolution(`watch task created: ${task.market}/${task.code}`, 'ok');
            },
            onNo: () => canceledResolution,
          }),
        );
      },
    }),
  );
}

async function runGroup(
  argv: { positional: readonly string[] },
  ctx: Parameters<CommandSpec['run']>[1],
) {
  const name = argv.positional[1];
  const state = argv.positional[2];
  if (name === undefined || state === undefined) {
    return textErr('usage: watch group <name> <on|off>');
  }
  let enabled: boolean;
  if (state === 'on' || state === 'resume') enabled = true;
  else if (state === 'off' || state === 'pause') enabled = false;
  else return textErr(`watch group: state must be on/off (got ${state})`);
  await ctx.actions.run(watchGroupToggleAction, { name, enabled }, { signal: ctx.signal });
  return textOk(`watch group ${name} ${enabled ? 'resumed' : 'paused'}`);
}

async function runRemove(
  argv: { positional: readonly string[] },
  ctx: Parameters<CommandSpec['run']>[1],
) {
  const market = argv.positional[1];
  const code = argv.positional[2];
  if (market === undefined || code === undefined) {
    return textErr('usage: watch rm <market> <code>');
  }
  if (!isWatchMarket(market)) {
    return textErr(`watch rm: market must be one of ${MARKETS.join('/')}`);
  }
  if (!isValidWatchCode(market, code)) {
    return textErr(
      `watch rm: code "${code}" is not valid for market ${market} — expected ${codeHint(market)}`,
    );
  }
  await ctx.actions.run(watchRemoveAction, { market, code }, { signal: ctx.signal });
  return textOk(`removed watch ${market}/${code}`);
}
