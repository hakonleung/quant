import { Inject, Injectable } from '@nestjs/common';
import {
  HelpArgsSchema,
  instructionId,
  okResult,
  okResultWithMeta,
  type InstructionResult,
} from '@quant/shared';
import type { z } from 'zod';

import type { InstructionCtx } from '../instruction.port.js';
import { InstructionRegistrarBase } from '../instruction.provider.js';
import { InstructionRegistry } from '../instruction.registry.js';
import type { InstructionEntry } from '../instruction.registry.js';
import type { InstructionGroup, InstructionSpec } from '../instruction.types.js';

const argsSchema = HelpArgsSchema;
type Args = z.infer<typeof argsSchema>;

/** Display order and bilingual labels for each group. */
const GROUP_ORDER: readonly InstructionGroup[] = ['market', 'portfolio', 'watch', 'system'];

const GROUP_LABEL: Record<InstructionGroup, string> = {
  market: '行情 Market',
  portfolio: '持仓 Portfolio',
  watch: '预警 Watch',
  system: '系统 System',
};

@Injectable()
export class HelpHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('help'),
    summary: 'List registered instructions, or show detail for one id.',
    summaryCn: '列出全部指令或查看某条指令详情',
    group: 'system',
    argsSchema,
    positional: ['id'],
    imAliases: ['帮助'],
    examples: ['help', 'help sector', 'help watch.add'],
  };

  constructor(@Inject(InstructionRegistry) registry: InstructionRegistry) {
    super(registry);
  }

  execute(args: Args, _ctx: InstructionCtx): Promise<InstructionResult> {
    if (args.id !== undefined && args.id.length > 0) {
      return Promise.resolve(this.replyDetail(args.id));
    }
    return Promise.resolve(this.replyList());
  }

  // ── list ──────────────────────────────────────────────────────────────

  private replyList(): InstructionResult {
    const entries = this.registry.list();
    const byGroup = new Map<InstructionGroup, InstructionEntry[]>();
    for (const group of GROUP_ORDER) byGroup.set(group, []);
    // The pre-seeded buckets above guarantee `byGroup.get(group)` is
    // defined for every InstructionGroup; `system` exists by construction
    // as the safe fallback for unknown groups (no `!` needed).
    const systemBucket = byGroup.get('system') ?? [];
    if (!byGroup.has('system')) byGroup.set('system', systemBucket);
    for (const entry of entries) {
      const bucket = byGroup.get(entry.spec.group) ?? systemBucket;
      bucket.push(entry);
    }

    const tableSections: Record<string, unknown>[] = [];
    const textSections: string[] = [];
    for (const group of GROUP_ORDER) {
      const bucket = byGroup.get(group);
      if (bucket === undefined || bucket.length === 0) continue;
      const sorted = [...bucket].sort((a, b) => a.spec.id.localeCompare(b.spec.id));
      const rows = sorted.map((e) => buildHelpRow(e.spec));
      tableSections.push({
        title: GROUP_LABEL[group],
        columns: [
          { name: 'id', displayName: 'id', horizontalAlign: 'left', width: '160px' },
          { name: 'tags', displayName: 'tag', horizontalAlign: 'left', width: '80px' },
          { name: 'cn', displayName: '中文', horizontalAlign: 'left' },
          { name: 'example', displayName: '示例', horizontalAlign: 'left', width: '220px' },
        ],
        rows: rows.map((r) => ({
          id: r.id,
          tags: r.tags,
          cn: r.cn,
          example: r.example,
        })),
        // Why: Feishu's native `table` defaults to page_size=10. Help
        // groups regularly grow past that (market currently has 12 rows
        // including ta / ta.sector); without this hint the tail entries
        // get hidden on page 2 and look "deleted".
        pageSize: Math.max(10, rows.length),
        // Default `low` clips long Chinese summaries / multi-arg
        // example commands on a single line; `auto` lets cells wrap.
        rowHeight: 'auto',
      });
      textSections.push(`【${GROUP_LABEL[group]}】\n${renderHelpTable(rows)}`);
    }
    return okResultWithMeta(textSections.join('\n\n'), {
      tableSections,
      tablesSubheader: '使用 `help <id>` 查看单条指令详情',
    });
  }

  // ── detail ────────────────────────────────────────────────────────────

  private replyDetail(id: string): InstructionResult {
    const entry = this.registry.get(id);
    if (entry === undefined) return okResult(`unknown instruction: ${id}`);
    const { spec } = entry;
    const fields = detailFields(spec);
    const lines = [`${buildAliasLine(spec)}  ·  ${GROUP_LABEL[spec.group]}`];
    for (const [k, v] of fields) lines.push(`${k}: ${v}`);
    const text = lines.join('\n');
    return okResultWithMeta(text, {
      tableSections: [
        {
          title: `/${String(spec.id)}`,
          columns: [
            { name: 'k', displayName: '字段', horizontalAlign: 'left', width: '110px' },
            { name: 'v', displayName: '内容', horizontalAlign: 'left' },
          ],
          rows: fields.map(([k, v]) => ({ k, v })),
        },
      ],
    });
  }
}

// ── pure helpers ──────────────────────────────────────────────────────────

interface HelpRow {
  readonly id: string;
  readonly tags: string;
  readonly cn: string;
  readonly en: string;
  readonly example: string;
}

function buildAliasLine(spec: InstructionSpec<unknown>): string {
  const cn =
    spec.imAliases !== undefined && spec.imAliases.length > 0
      ? ` / ${spec.imAliases.join('/')}`
      : '';
  return `${String(spec.id)}${cn}`;
}

function formatTags(spec: InstructionSpec<unknown>): string {
  const tags: string[] = [];
  if (spec.costsCredits === true) tags.push('$');
  if (spec.destructive === true) tags.push('!');
  if (spec.mode === 'async') tags.push('⏳');
  return tags.length > 0 ? `[${tags.join('')}]` : '';
}

/**
 * Produce a representative invocation. Uses the first explicit example
 * when provided, else builds a stub from `positional` (`<sub>` /
 * `<code>` placeholders), else falls back to the bare id.
 */
function buildExample(spec: InstructionSpec<unknown>): string {
  if (spec.examples !== undefined && spec.examples.length > 0) {
    const first = spec.examples[0];
    if (typeof first === 'string' && first.length > 0) return first;
  }
  const id = String(spec.id);
  if (spec.positional !== undefined && spec.positional.length > 0) {
    return `${id} ${spec.positional.map((p) => `<${p}>`).join(' ')}`;
  }
  return id;
}

function buildHelpRow(spec: InstructionSpec<unknown>): HelpRow {
  return {
    id: buildAliasLine(spec),
    tags: formatTags(spec),
    cn: spec.summaryCn,
    en: spec.summary,
    example: buildExample(spec),
  };
}

function paramsField(spec: InstructionSpec<unknown>): string {
  if (spec.positional !== undefined && spec.positional.length > 0) {
    return `${spec.positional.map((p) => `<${p}>`).join(' ')} （位置参数，按顺序）；其余以 key=value 形式传入`;
  }
  return '无 / 仅 key=value 形式';
}

function tagFields(spec: InstructionSpec<unknown>): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  if (spec.mode === 'async') out.push(['执行方式', '异步（先收到开始通知，再收到完成回调）']);
  if (spec.costsCredits === true) out.push(['标签', '[$] 调用会触发外部付费 LLM']);
  if (spec.destructive === true) out.push(['标签', '[!] 写操作 / 不可逆']);
  return out;
}

function detailFields(spec: InstructionSpec<unknown>): readonly (readonly [string, string])[] {
  const examples =
    spec.examples !== undefined && spec.examples.length > 0
      ? spec.examples
      : [buildExample(spec)];
  const fields: (readonly [string, string])[] = [
    ['中文', spec.summaryCn],
    ['English', spec.summary],
  ];
  if (spec.help !== undefined && spec.help.length > 0) fields.push(['说明', spec.help]);
  fields.push(['参数', paramsField(spec)]);
  fields.push(['示例', examples.join('\n')]);
  if (spec.aliases !== undefined && spec.aliases.length > 0) {
    fields.push(['别名', spec.aliases.join(', ')]);
  }
  if (spec.imAliases !== undefined && spec.imAliases.length > 0) {
    fields.push(['中文别名', spec.imAliases.join('、')]);
  }
  fields.push(...tagFields(spec));
  return fields;
}

/**
 * Code-fenced fixed-width fallback used by terminal / Slack consumers
 * (`text`). Feishu picks `tableSections` from `meta` and renders native
 * tables instead.
 */
function renderHelpTable(rows: readonly HelpRow[]): string {
  const HEADER: HelpRow = { id: 'id', tags: 'tag', cn: '中文', en: 'English', example: '示例' };
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
  const lines = ['```', fmt(HEADER), sep, ...rows.map(fmt), '```'];
  return lines.join('\n');
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
