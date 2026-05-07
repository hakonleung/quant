import {
  screenNlAction,
  sectorListAction,
  sectorRefreshDynamicAction,
  sectorRemoveAction,
  sectorShowAction,
  sectorUpsertAction,
  type Sector,
  stockSnapshotsAction,
} from '../actions/registry.js';
import { ANSI, paint } from '../render/ansi.js';
import { renderTable } from '../render/table.js';
import type { CommandSpec } from '../registry.js';
import { confirmPrompt } from '../widgets/confirm-prompt.js';
import { formPrompt } from '../widgets/form-prompt.js';
import { pasteText } from '../widgets/paste-text.js';
import { pickStockLoop } from '../widgets/pick-stock-loop.js';
import { selectableList } from '../widgets/selectable-list.js';
import {
  interactive,
  noopResolution,
  canceledResolution,
  outputResolution,
  textErr,
  textOk,
  widgetResolution,
} from '../widgets/helpers.js';

const ALL_ID = 'all';

export const sectorCommand: CommandSpec = {
  name: 'sector',
  summary: 'Sector management. Subcommands: list, show, add, refresh, rm.',
  subcommands: ['list', 'show', 'add', 'refresh', 'rm'],
  async run(argv, ctx) {
    const sub = argv.positional[0];
    if (sub === undefined) return textErr('sector: missing subcommand');
    if (sub === 'list') return runList(ctx);
    if (sub === 'show') return runShow(argv, ctx);
    if (sub === 'add') return runAdd(ctx);
    if (sub === 'refresh') return runRefresh(argv, ctx);
    if (sub === 'rm') return runRemove(argv, ctx);
    return textErr(`sector: unknown subcommand ${sub}`);
  },
};

async function runList(ctx: Parameters<CommandSpec['run']>[1]) {
  const r = await ctx.actions.run(sectorListAction, {}, { signal: ctx.signal });
  const rows = r.data
    .filter((s) => s.id !== ALL_ID)
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      count: s.count,
      chgPct: s.chgPct ?? 0,
    }));
  if (rows.length === 0) {
    return textOk(paint('no sectors yet — try `sector add`', ANSI.gray));
  }
  const widget = selectableList({
    title: 'sectors',
    items: rows,
    columns: [
      { key: 'id', header: 'ID', max: 12 },
      { key: 'name', header: 'NAME', max: 14 },
      { key: 'kind', header: 'KIND', max: 8 },
      { key: 'count', header: 'N', align: 'right' },
      { key: 'chgPct', header: 'CHG%', align: 'right' },
    ],
    onCommit: (s) => ({ kind: 'command', line: `sector show ${String(s.id)}` }),
    extraKeys: [
      {
        key: 'a',
        hint: { keys: ['a'], label: 'analyze (paid)', danger: true },
        resolve: (s) =>
          widgetResolution(
            confirmPrompt({
              title: `analyze sector ${String(s.name)} (paid)`,
              danger: true,
              onYes: () => ({ kind: 'command', line: `analyze sector ${String(s.id)} --force` }),
              onNo: () => canceledResolution,
            }),
          ),
      },
      {
        key: 'd',
        hint: { keys: ['d'], label: 'delete', danger: true },
        resolve: (s) =>
          widgetResolution(
            confirmPrompt({
              title: `delete sector ${String(s.name)}?`,
              danger: true,
              onYes: () => ({ kind: 'command', line: `sector rm ${String(s.id)}` }),
              onNo: () => canceledResolution,
            }),
          ),
      },
    ],
  });
  return interactive(widget);
}

async function runShow(
  argv: { positional: readonly string[] },
  ctx: Parameters<CommandSpec['run']>[1],
) {
  const idOrName = argv.positional[1];
  if (idOrName === undefined)
    return textErr('usage: sector show <id|name>   (use `all` for the full universe)');
  const isAll = idOrName.toLowerCase() === ALL_ID;
  let sectorName: string;
  let codes: readonly string[];
  if (isAll) {
    sectorName = 'ALL';
    codes = ctx.stockIndex.all().map((m) => m.code);
  } else {
    const r = await ctx.actions.run(sectorShowAction, { idOrName }, { signal: ctx.signal });
    sectorName = r.data.name;
    codes = r.data.codes;
  }
  // Snapshots for `all` could be huge; cap at the first 200 for the table.
  const previewCodes = codes.slice(0, 200);
  const snaps = await ctx.actions.run(
    stockSnapshotsAction,
    { codes: previewCodes },
    { signal: ctx.signal },
  );
  const items = previewCodes.map((code) => {
    const meta = ctx.stockIndex.byCode(code);
    const snap = snaps.data.find((s) => s.code === code);
    return {
      code,
      name: meta?.name ?? code,
      price: snap?.price ?? 0,
      pe: snap?.pe_ttm ?? 0,
    };
  });
  const titleSuffix =
    codes.length > items.length
      ? `${String(items.length)} of ${String(codes.length)} shown`
      : `${String(items.length)} members`;
  const widget = selectableList({
    title: `sector ${sectorName} (${titleSuffix})`,
    items,
    columns: [
      { key: 'code', header: 'CODE', max: 8 },
      { key: 'name', header: 'NAME', max: 14 },
      { key: 'price', header: 'PX', align: 'right' },
      { key: 'pe', header: 'PE', align: 'right' },
    ],
    onCommit: (s) => ({ kind: 'command', line: `stock info ${String(s.code)}` }),
    extraKeys: [
      {
        key: 'a',
        hint: { keys: ['a'], label: 'analyze (paid)', danger: true },
        resolve: (s) =>
          widgetResolution(
            confirmPrompt({
              title: `analyze ${String(s.code)} (paid)`,
              danger: true,
              onYes: () => ({ kind: 'command', line: `analyze ${String(s.code)} --force` }),
              onNo: () => canceledResolution,
            }),
          ),
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

async function runRemove(
  argv: { positional: readonly string[] },
  ctx: Parameters<CommandSpec['run']>[1],
) {
  const idOrName = argv.positional[1];
  if (idOrName === undefined) return textErr('usage: sector rm <id|name>');
  await ctx.actions.run(sectorRemoveAction, { idOrName }, { signal: ctx.signal });
  return textOk(`removed sector ${idOrName}`);
}

async function runRefresh(
  argv: { positional: readonly string[] },
  ctx: Parameters<CommandSpec['run']>[1],
) {
  const idOrName = argv.positional[1];
  if (idOrName === undefined) return textErr('usage: sector refresh <id|name>');
  const r = await ctx.actions.run(sectorRefreshDynamicAction, { idOrName }, { signal: ctx.signal });
  return textOk(
    `refreshed sector ${r.data.name}: codes=${String(r.data.count)} chgPct=${String(r.data.chgPct ?? '—')}`,
  );
}

/* ---------- sector add — guided flow ---------- */

async function runAdd(ctx: Parameters<CommandSpec['run']>[1]) {
  return interactive(
    formPrompt({
      title: 'sector add (1/2): name',
      fields: [
        {
          key: 'name',
          label: 'name',
          kind: 'text',
          placeholder: 'sector display name',
          validate: (v) => (v.length === 0 ? 'name is required' : null),
        },
      ],
      onSubmit: (v) => widgetResolution(addPickKind(ctx, v['name'] ?? '')),
    }),
  );
}

function addPickKind(ctx: Parameters<CommandSpec['run']>[1], name: string) {
  return formPrompt({
    title: `sector add (2/2): "${name}" — pick kind`,
    fields: [
      {
        key: 'kind',
        label: 'kind',
        kind: 'enum',
        options: ['user', 'dynamic'],
        initial: 'user',
      },
    ],
    onSubmit: (v) =>
      v['kind'] === 'dynamic'
        ? widgetResolution(addDynamicNl(ctx, name))
        : widgetResolution(addUserMethod(ctx, name)),
  });
}

function addUserMethod(ctx: Parameters<CommandSpec['run']>[1], name: string) {
  return formPrompt({
    title: `sector add user/${name}: pick method`,
    fields: [
      {
        key: 'method',
        label: 'method',
        kind: 'enum',
        options: ['single', 'paste-json', 'paste-csv'],
        initial: 'single',
      },
    ],
    onSubmit: (v) => {
      const method = v['method'] ?? 'single';
      if (method === 'single') return widgetResolution(addUserSingle(ctx, name));
      if (method === 'paste-json') return widgetResolution(addUserPaste(ctx, name, 'json'));
      return widgetResolution(addUserPaste(ctx, name, 'csv'));
    },
  });
}

function addUserSingle(ctx: Parameters<CommandSpec['run']>[1], name: string) {
  const universe = ctx.stockIndex.all().map((m) => ({ code: m.code, name: m.name }));
  return pickStockLoop({
    title: `sector add user/${name}: build basket`,
    universe,
    onApply: (codes) => widgetResolution(addUserConfirm(ctx, name, codes)),
  });
}

function addUserPaste(ctx: Parameters<CommandSpec['run']>[1], name: string, mode: 'json' | 'csv') {
  return pasteText({
    title: `sector add user/${name}: paste ${mode}`,
    placeholder:
      mode === 'json'
        ? '["600519","000001",...]   then Ctrl+Enter'
        : '600519,000001 (or one per line)   then Ctrl+Enter',
    onSubmit: (text) => {
      const parsed = parseCodesText(text, mode);
      if (parsed.invalid.length > 0 && parsed.valid.length === 0) {
        return outputResolution(`no valid codes parsed (${parsed.invalid.length} bad)`, 'err');
      }
      // Cross with universe for validity
      const inUniverse = parsed.valid.filter((c) => ctx.stockIndex.byCode(c) !== null);
      const items = parsed.valid.map((code) => {
        const meta = ctx.stockIndex.byCode(code);
        return { code, name: meta?.name ?? '(unknown)', valid: meta !== null };
      });
      return widgetResolution(
        selectableList({
          title: `sector add user/${name}: ${String(inUniverse.length)} of ${String(parsed.valid.length)} valid`,
          items,
          columns: [
            { key: 'code', header: 'CODE', max: 8 },
            { key: 'name', header: 'NAME', max: 16 },
            { key: 'valid', header: 'OK', max: 4 },
          ],
          extraKeys: [
            {
              key: 'a',
              hint: { keys: ['a'], label: 'apply valid codes' },
              resolve: () => widgetResolution(addUserConfirm(ctx, name, inUniverse)),
            },
          ],
        }),
      );
    },
  });
}

function addUserConfirm(
  ctx: Parameters<CommandSpec['run']>[1],
  name: string,
  codes: readonly string[],
) {
  return confirmPrompt({
    title: `save user sector "${name}" (${String(codes.length)} codes)?`,
    onYes: () => {
      const sector: Sector = {
        id: name.toLowerCase().replace(/\s+/gu, '-'),
        name,
        kind: 'user',
        count: codes.length,
        meta: '',
        chgPct: null,
        codes: [...codes],
      };
      // Fire-and-forget — the engine will surface any thrown error in next tick.
      void ctx.actions.run(sectorUpsertAction, { sector }, { signal: ctx.signal });
      return outputResolution(`saved user sector "${name}" (${String(codes.length)} codes)`, 'ok');
    },
    onNo: () => canceledResolution,
  });
}

function addDynamicNl(ctx: Parameters<CommandSpec['run']>[1], name: string) {
  return pasteText({
    title: `sector add dynamic/${name}: NL query`,
    placeholder: 'e.g. 近 60 日 3 次涨停    (Ctrl+Enter to submit)',
    onSubmit: (text) => widgetResolution(addDynamicConfirm(ctx, name, text)),
  });
}

function addDynamicConfirm(ctx: Parameters<CommandSpec['run']>[1], name: string, nl: string) {
  return confirmPrompt({
    title: `dynamic sector "${name}": run NL → DSL screen (paid)?`,
    danger: true,
    onYes: () => {
      void (async (): Promise<void> => {
        const r = await ctx.actions.run(screenNlAction, { nl }, { signal: ctx.signal });
        const codes = r.data.matches.map((m) => m.code);
        const sector: Sector = {
          id: name.toLowerCase().replace(/\s+/gu, '-'),
          name,
          kind: 'dynamic',
          count: codes.length,
          meta: r.data.dslSummary,
          chgPct: null,
          codes,
          nl,
        };
        await ctx.actions.run(sectorUpsertAction, { sector }, { signal: ctx.signal });
      })();
      return outputResolution(
        `dispatched dynamic sector "${name}" (NL=${JSON.stringify(nl)})`,
        'ok',
      );
    },
    onNo: () => canceledResolution,
  });
}

void renderTable; // referenced for future error preview render
void noopResolution;

/* ---------- helpers ---------- */

function parseCodesText(
  text: string,
  mode: 'json' | 'csv',
): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  let raw: unknown[];
  if (mode === 'json') {
    try {
      const parsed = JSON.parse(text) as unknown;
      raw = Array.isArray(parsed) ? parsed : [];
    } catch {
      return { valid: [], invalid: [text] };
    }
  } else {
    raw = text
      .split(/[\s,]+/u)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  for (const item of raw) {
    const s = typeof item === 'string' ? item : String(item);
    if (/^\d{6}$/u.test(s)) valid.push(s);
    else invalid.push(s);
  }
  return { valid, invalid };
}
