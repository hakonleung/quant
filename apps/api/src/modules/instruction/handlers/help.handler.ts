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
      const rows = sorted.map((e) => formatListRow(e.spec));
      sections.push(`── ${GROUP_LABEL[group]} ──\n${rows.join('\n')}`);
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

function buildAliasLine(spec: InstructionSpec<unknown>): string {
  const cn = spec.imAliases !== undefined && spec.imAliases.length > 0
    ? ` / ${spec.imAliases.join('/')}`
    : '';
  return `${String(spec.id)}${cn}`;
}

function formatTags(spec: InstructionSpec<unknown>): string {
  const tags: string[] = [];
  if (spec.costsCredits === true) tags.push('[$]');
  if (spec.destructive === true) tags.push('[!]');
  return tags.length > 0 ? ` ${tags.join('')}` : '';
}

function formatListRow(spec: InstructionSpec<unknown>): string {
  const label = (buildAliasLine(spec) + formatTags(spec)).padEnd(26);
  return `  ${label}  ${spec.summaryCn}  ·  ${spec.summary}`;
}
