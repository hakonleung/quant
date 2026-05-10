import { Inject, Injectable } from '@nestjs/common';
import {
  instructionId,
  okResult,
  okResultWithMeta,
  type InstructionResult,
  type StockSnapshotDto,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import {
  formatStockTable,
  rowFromSnapshot,
  stockTableMetaColumns,
  stockTableMetaRows,
  type StockTableRow,
} from '../domain/format-stock-table.js';
import { StockMetaService } from '../stock-meta.service.js';

const argsSchema = z
  .object({
    q: z.string().min(1, 'query required').max(64).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

@Injectable()
export class StockInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('stock'),
    summary: 'Search A-share metadata by code, name, or pinyin fragment.',
    summaryCn: '按代码、名称或拼音搜索股票',
    group: 'market',
    argsSchema,
    positional: ['q'],
    imAliases: ['股票'],
    examples: ['stock 600519', 'stock 茅台', 'stock mt limit=20'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(StockMetaService) private readonly stockMeta: StockMetaService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const all = await this.stockMeta.listAll(ctx.traceId);
    const q = (args.q ?? '').toLowerCase();
    const matches =
      q.length === 0
        ? all.slice(0, args.limit)
        : all
            .filter(
              (m) =>
                m.code.includes(q) ||
                m.name.toLowerCase().includes(q) ||
                m.name_pinyin.toLowerCase().includes(q),
            )
            .slice(0, args.limit);
    if (matches.length === 0) return okResult(`no match for "${args.q ?? ''}"`);

    const subheader = `stock matches (${String(matches.length)})`;
    const rows = await this.buildRows(matches, ctx.traceId);
    const text = `${subheader}\n\n${formatStockTable(rows)}`;
    return okResultWithMeta(text, {
      stockTableColumns: stockTableMetaColumns(),
      stockTableRows: stockTableMetaRows(rows),
      stockTableSubheader: subheader,
    });
  }

  /**
   * Join the matched meta rows with the cached snapshot universe so the
   * IM table renders price + multi-period returns in addition to the
   * code/name/industry columns. Falls back to meta-only rows if the
   * snapshot fetch fails — still better than no table at all.
   */
  private async buildRows(
    matches: readonly { readonly code: string; readonly name: string }[],
    traceId: string,
  ): Promise<readonly StockTableRow[]> {
    let byCode: Map<string, StockSnapshotDto>;
    try {
      const snapshots = await this.stockMeta.snapshotAll(traceId);
      byCode = new Map(snapshots.map((s) => [s.meta.code, s]));
    } catch {
      byCode = new Map();
    }
    return matches.map((m) =>
      rowFromSnapshot({ code: m.code, name: m.name, snapshot: byCode.get(m.code) }),
    );
  }
}
