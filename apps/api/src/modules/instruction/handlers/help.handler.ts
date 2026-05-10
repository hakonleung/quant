import { Inject, Injectable } from '@nestjs/common';
import { instructionId, okResult, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../instruction.port.js';
import { InstructionRegistrarBase } from '../instruction.provider.js';
import { InstructionRegistry } from '../instruction.registry.js';
import type { InstructionEntry } from '../instruction.registry.js';
import type { InstructionGroup, InstructionSpec } from '../instruction.types.js';

const argsSchema = z
  .object({
    id: z.string().optional(),
  })
  .strict();

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
  };

  constructor(@Inject(InstructionRegistry) registry: InstructionRegistry) {
    super(registry);
  }

  execute(args: Args, _ctx: InstructionCtx): Promise<InstructionResult> {
    if (args.id !== undefined && args.id.length > 0) {
      return Promise.resolve(okResult(this.formatDetail(args.id)));
    }
    return Promise.resolve(okResult(this.formatList()));
  }

  // ── list ──────────────────────────────────────────────────────────────

  /**
   * Render the registered instructions as a single fixed-width table.
   *
   * Why a code-fenced table: previous output put the CN summary and the
   * EN summary on the same line, joined by ` · `. In Feishu's `lark_md`
   * panels that line was usually wider than the card and wrapped, so the
   * user saw the Chinese half on top and the English half below — the
   * "上中下英" effect they reported. A code-fenced table forces a
   * monospace column layout and prevents Lark from collapsing whitespace
   * or wrapping individual rows, so each row stays on one line and the
   * CN / EN columns sit side-by-side.
   */
  private formatList(): string {
    const entries = this.registry.list();
    const byGroup = new Map<InstructionGroup, InstructionEntry[]>();
    for (const group of GROUP_ORDER) byGroup.set(group, []);

    for (const entry of entries) {
      const group = entry.spec.group;
      const bucket = byGroup.get(group);
      // Unknown groups fall into system as a safe fallback.
      const target = bucket ?? (byGroup.get('system') as InstructionEntry[]);
      target.push(entry);
    }

    const sections: string[] = [];
    for (const group of GROUP_ORDER) {
      const bucket = byGroup.get(group);
      if (bucket === undefined || bucket.length === 0) continue;
      const sorted = [...bucket].sort((a, b) => a.spec.id.localeCompare(b.spec.id));
      const rows = sorted.map((e) => buildHelpRow(e.spec));
      sections.push(`【${GROUP_LABEL[group]}】\n${renderHelpTable(rows)}`);
    }
    return sections.join('\n\n');
  }

  // ── detail ────────────────────────────────────────────────────────────

  private formatDetail(id: string): string {
    const entry = this.registry.get(id);
    if (entry === undefined) return `unknown instruction: ${id}`;
    const { spec } = entry;

    const header = buildAliasLine(spec);
    const lines: string[] = [
      `${header}  ·  ${GROUP_LABEL[spec.group]}`,
      `中文: ${spec.summaryCn}`,
      `英文: ${spec.summary}`,
    ];
    if (spec.help !== undefined) lines.push(spec.help);
    if (spec.positional !== undefined && spec.positional.length > 0) {
      lines.push(`用法: ${String(spec.id)} ${spec.positional.join(' ')}`);
    }
    if (spec.aliases !== undefined && spec.aliases.length > 0) {
      lines.push(`别名: ${spec.aliases.join(', ')}`);
    }
    if (spec.imAliases !== undefined && spec.imAliases.length > 0) {
      lines.push(`中文别名: ${spec.imAliases.join('、')}`);
    }
    if (spec.mode === 'async') lines.push('执行方式: 异步（收到开始通知后等待完成回调）');
    if (spec.costsCredits === true) lines.push('标签: [$] 调用会触发外部付费 LLM');
    if (spec.destructive === true) lines.push('标签: [!] 写操作 / 不可逆');
    return lines.join('\n');
  }
}

// ── pure helpers ──────────────────────────────────────────────────────────

interface HelpRow {
  readonly id: string;
  readonly tags: string;
  readonly cn: string;
  readonly en: string;
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

function buildHelpRow(spec: InstructionSpec<unknown>): HelpRow {
  return {
    id: buildAliasLine(spec),
    tags: formatTags(spec),
    cn: spec.summaryCn,
    en: spec.summary,
  };
}

/**
 * Render the help rows as a fixed-width text table wrapped in a
 * triple-backtick fence so Feishu / Slack preserve the column padding
 * and stop trying to wrap or collapse whitespace. CN and EN sit in
 * separate columns side-by-side — addresses the "上中下英" report.
 */
function renderHelpTable(rows: readonly HelpRow[]): string {
  const HEADER: HelpRow = { id: 'id', tags: 'tag', cn: '中文', en: 'English' };
  const all: readonly HelpRow[] = [HEADER, ...rows];
  const w = {
    id: maxWidth(all, (r) => r.id),
    tags: maxWidth(all, (r) => r.tags),
    cn: maxWidth(all, (r) => r.cn),
    en: maxWidth(all, (r) => r.en),
  };
  const fmt = (r: HelpRow): string =>
    [
      pad(r.id, w.id, 'left'),
      pad(r.tags, w.tags, 'left'),
      pad(r.cn, w.cn, 'left'),
      pad(r.en, w.en, 'left'),
    ].join('  ');
  const sep = `${'─'.repeat(w.id)}  ${'─'.repeat(w.tags)}  ${'─'.repeat(w.cn)}  ${'─'.repeat(w.en)}`;
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

/**
 * East-Asian wide chars (most CJK) take ~2 monospace columns.
 * Mirrors the helper in `format-stock-table.ts` — kept inline here to
 * keep the help handler self-contained (CLAUDE.md §2.5.2 rule-of-three:
 * two callers is not yet enough to justify extracting a shared module).
 */
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
