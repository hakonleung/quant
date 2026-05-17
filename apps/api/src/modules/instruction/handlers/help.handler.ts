/**
 * `/help` — IM-facing instruction list and detail.
 *
 * Source of truth is `COMMAND_MANIFEST` from `@quant/shared`, which
 * covers every command on either side (legacy `InstructionRegistry`
 * handlers and migrated `InstructionCenter` cells). The legacy code
 * path only enumerated `registry.list()`, which silently hid all
 * center-only commands (sector / stock / ledger / watch / analyze /
 * ta / screen / focus / …) from IM users — that is the bug this
 * module exists to fix.
 *
 * Renders two surfaces from the same data:
 *   - `tableSections` meta — Feishu adapter turns each into a native
 *     table card (one per group)
 *   - plain text fallback — fixed-width tables for terminal / Slack
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  COMMAND_MANIFEST,
  HelpArgsSchema,
  type CommandGroup,
  type CommandManifestEntry,
  instructionId,
  okResult,
  okResultWithMeta,
  type InstructionResult,
} from '@quant/shared';
import type { z } from 'zod';

import type { InstructionCtx } from '../instruction.port.js';
import { InstructionRegistrarBase } from '../instruction.provider.js';
import { InstructionRegistry } from '../instruction.registry.js';
import type { InstructionSpec } from '../instruction.types.js';

const argsSchema = HelpArgsSchema;
type Args = z.infer<typeof argsSchema>;

/** Display order — agent / market / sector first since they're what users mostly call. */
const GROUP_ORDER: readonly CommandGroup[] = [
  'market',
  'sector',
  'watch',
  'ledger',
  'agent',
  'channel',
  'ui',
  'system',
];

const GROUP_LABEL: Record<CommandGroup, string> = {
  market: '行情 Market',
  sector: '板块 Sector',
  watch: '预警 Watch',
  ledger: '账本 Ledger',
  agent: '助手 Agent',
  channel: '频道 Channel',
  ui: '界面 UI',
  system: '系统 System',
};

@Injectable()
export class HelpHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('help'),
    summary: 'List every instruction, or show detail for one id.',
    summaryCn: '列出全部指令或查看某条指令详情',
    group: 'system',
    argsSchema,
    positional: ['id'],
    imAliases: ['帮助'],
    examples: ['help', 'help sector.show', 'help id=watch.add'],
  };

  constructor(@Inject(InstructionRegistry) registry: InstructionRegistry) {
    super(registry);
  }

  execute(args: Args, _ctx: InstructionCtx): Promise<InstructionResult> {
    if (args.id !== undefined && args.id.length > 0) {
      return Promise.resolve(replyDetail(args.id));
    }
    return Promise.resolve(replyList());
  }
}

// ── list ──────────────────────────────────────────────────────────────────

function replyList(): InstructionResult {
  // Feishu rejects cards with more than a handful of `table` elements
  // (ErrCode 11310: "card table number over limit"). Emit one combined
  // table with a `group` column instead of one table per group — also
  // makes Ctrl+F search easier for users.
  const byGroup = bucketByGroup();
  const allRows: (HelpRow & { readonly group: string })[] = [];
  const textSections: string[] = [];

  for (const group of GROUP_ORDER) {
    const bucket = byGroup.get(group);
    if (bucket === undefined || bucket.length === 0) continue;
    const sorted = [...bucket].sort((a, b) => a.id.localeCompare(b.id));
    const rows = sorted.map(buildHelpRow);
    for (const r of rows) allRows.push({ ...r, group: GROUP_LABEL[group] });
    textSections.push(`【${GROUP_LABEL[group]}】\n${renderHelpTable(rows)}`);
  }

  const tableSection = {
    title: '全部指令 / All Instructions',
    columns: [
      { name: 'group', displayName: '类别', horizontalAlign: 'left', width: '120px' },
      { name: 'id', displayName: 'id', horizontalAlign: 'left', width: '160px' },
      { name: 'tags', displayName: 'tag', horizontalAlign: 'left', width: '70px' },
      { name: 'cn', displayName: '中文', horizontalAlign: 'left' },
      { name: 'example', displayName: '示例', horizontalAlign: 'left', width: '240px' },
    ],
    rows: allRows.map((r) => ({
      group: r.group,
      id: r.id,
      tags: r.tags,
      cn: r.cn,
      example: r.example,
    })),
    // Default page_size=10 hides the long tail. Show every row.
    pageSize: Math.max(10, allRows.length),
    rowHeight: 'auto',
  };

  return okResultWithMeta(textSections.join('\n\n'), {
    tableSections: [tableSection],
    tablesSubheader: '使用 `help <id>` 查看单条指令详情',
  });
}

function bucketByGroup(): ReadonlyMap<CommandGroup, CommandManifestEntry[]> {
  const out = new Map<CommandGroup, CommandManifestEntry[]>();
  for (const g of GROUP_ORDER) out.set(g, []);
  for (const entry of COMMAND_MANIFEST) {
    const bucket = out.get(entry.group);
    if (bucket === undefined) {
      // Defensive: unknown group → drop into `system` so it still surfaces.
      const sys = out.get('system');
      if (sys !== undefined) sys.push(entry);
      continue;
    }
    bucket.push(entry);
  }
  return out;
}

// ── detail ────────────────────────────────────────────────────────────────

function replyDetail(idOrAlias: string): InstructionResult {
  const entry = lookup(idOrAlias);
  if (entry === undefined) return okResult(`unknown instruction: ${idOrAlias}`);
  const fields = detailFields(entry);
  const lines = [`${buildAliasLine(entry)}  ·  ${GROUP_LABEL[entry.group]}`];
  for (const [k, v] of fields) lines.push(`${k}: ${v}`);
  return okResultWithMeta(lines.join('\n'), {
    tableSections: [
      {
        title: `/${entry.id}`,
        columns: [
          { name: 'k', displayName: '字段', horizontalAlign: 'left', width: '110px' },
          { name: 'v', displayName: '内容', horizontalAlign: 'left' },
        ],
        rows: fields.map(([k, v]) => ({ k, v })),
      },
    ],
  });
}

function lookup(token: string): CommandManifestEntry | undefined {
  for (const e of COMMAND_MANIFEST) {
    if (e.id === token) return e;
    if ((e.aliases ?? []).includes(token)) return e;
  }
  return undefined;
}

// ── pure helpers ──────────────────────────────────────────────────────────

interface HelpRow {
  readonly id: string;
  readonly tags: string;
  readonly cn: string;
  readonly example: string;
}

function buildAliasLine(entry: CommandManifestEntry): string {
  const a = entry.aliases ?? [];
  return a.length > 0 ? `${entry.id} / ${a.join('/')}` : entry.id;
}

function formatTags(entry: CommandManifestEntry): string {
  const tags: string[] = [];
  if (entry.doubleConfirm === 'llm') tags.push('$');
  if (entry.doubleConfirm === 'destructive') tags.push('!');
  if (entry.mode === 'async') tags.push('⏳');
  return tags.length > 0 ? `[${tags.join('')}]` : '';
}

/** First example if provided; else a positional-derived stub. */
function buildExample(entry: CommandManifestEntry): string {
  const ex = entry.examples ?? [];
  if (ex.length > 0 && ex[0] !== undefined && ex[0].length > 0) return ex[0];
  const pos = entry.positional ?? [];
  if (pos.length > 0) return `${entry.id} ${pos.map((p) => `<${p}>`).join(' ')}`;
  return entry.id;
}

function buildHelpRow(entry: CommandManifestEntry): HelpRow {
  return {
    id: buildAliasLine(entry),
    tags: formatTags(entry),
    cn: entry.summaryCn ?? entry.summary,
    example: buildExample(entry),
  };
}

function paramsField(entry: CommandManifestEntry): string {
  const pos = entry.positional ?? [];
  if (pos.length > 0) {
    return `${pos.map((p) => `<${p}>`).join(' ')} （位置参数，按顺序）；其余以 key=value 形式传入`;
  }
  return '无 / 仅 key=value 形式';
}

function tagFields(entry: CommandManifestEntry): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  if (entry.mode === 'async') out.push(['执行方式', '异步（先收到开始通知，再收到完成回调）']);
  if (entry.doubleConfirm === 'llm') out.push(['标签', '[$] 调用会触发外部付费 LLM']);
  if (entry.doubleConfirm === 'destructive') out.push(['标签', '[!] 写操作 / 不可逆']);
  return out;
}

function detailFields(
  entry: CommandManifestEntry,
): readonly (readonly [string, string])[] {
  const examples =
    entry.examples !== undefined && entry.examples.length > 0
      ? entry.examples
      : [buildExample(entry)];
  const fields: (readonly [string, string])[] = [
    ['中文', entry.summaryCn ?? entry.summary],
    ['English', entry.summary],
  ];
  if (entry.help !== undefined && entry.help.length > 0) fields.push(['说明', entry.help]);
  fields.push(['参数', paramsField(entry)]);
  fields.push(['示例', examples.map((e) => `/${e}`).join('\n')]);
  if (entry.aliases !== undefined && entry.aliases.length > 0) {
    fields.push(['别名', entry.aliases.join(', ')]);
  }
  fields.push(...tagFields(entry));
  return fields;
}

/** Plain-text fallback for terminal / Slack consumers (no Feishu tables). */
function renderHelpTable(rows: readonly HelpRow[]): string {
  const HEADER: HelpRow = { id: 'id', tags: 'tag', cn: '中文', example: '示例' };
  const all: readonly HelpRow[] = [HEADER, ...rows];
  const w = {
    id: maxWidth(all, (r) => r.id),
    tags: maxWidth(all, (r) => r.tags),
    cn: maxWidth(all, (r) => r.cn),
    example: maxWidth(all, (r) => r.example),
  };
  const fmt = (r: HelpRow): string =>
    [
      pad(r.id, w.id, 'left'),
      pad(r.tags, w.tags, 'left'),
      pad(r.cn, w.cn, 'left'),
      pad(r.example, w.example, 'left'),
    ].join('  ');
  const sep = `${'─'.repeat(w.id)}  ${'─'.repeat(w.tags)}  ${'─'.repeat(w.cn)}  ${'─'.repeat(w.example)}`;
  return ['```', fmt(HEADER), sep, ...rows.map(fmt), '```'].join('\n');
}

function maxWidth(rows: readonly HelpRow[], pick: (r: HelpRow) => string): number {
  let m = 0;
  for (const r of rows) {
    const w = displayWidth(pick(r));
    if (w > m) m = w;
  }
  return m;
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

function pad(s: string, target: number, side: 'left' | 'right'): string {
  const w = displayWidth(s);
  if (w >= target) return s;
  const fill = ' '.repeat(target - w);
  return side === 'left' ? s + fill : fill + s;
}
