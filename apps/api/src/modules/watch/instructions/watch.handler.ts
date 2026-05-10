/**
 * `watch` / `watch.list` — list every registered watch task with its
 * w-index, market:code, group, status, and stock-table rows (price +
 * period returns). `watch.add` and `watch.remove` are in separate files.
 */

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
import { StockMetaService } from '../../stock-meta/stock-meta.service.js';
import {
  formatStockTable,
  rowFromSnapshot,
  stockTableMetaRows,
  type StockTableRow,
} from '../../stock-meta/domain/format-stock-table.js';
import { WatchService } from '../watch.service.js';

const argsSchema = z
  .object({
    sub: z.enum(['list']).default('list'),
  })
  .strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class WatchInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('watch'),
    summary: 'List watch tasks with price + period returns table.',
    summaryCn: '预警任务列表（含价格涨跌幅）',
    group: 'watch',
    argsSchema,
    positional: ['sub'],
    aliases: [instructionId('watch.list')],
    imAliases: ['自选'],
    examples: ['watch'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(WatchService) private readonly watch: WatchService,
    @Inject(StockMetaService) private readonly stockMeta: StockMetaService,
  ) {
    super(registry);
  }

  async execute(_args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const tasks = await this.watch.list(ctx.userId);
    if (tasks.length === 0) return okResult('no watch tasks');

    // Task metadata lines: w1  a:600519  name  grp=daily  on/off  hits=3
    const metaLines = tasks.map((t) => {
      const wid = `w${String(t.idx)}`.padEnd(4);
      const key = `${t.market}:${t.code}`.padEnd(10);
      const name = t.name.slice(0, 8).padEnd(8);
      const grp = `grp=${t.groupName}`.padEnd(16);
      const status = t.enabled ? 'on ' : 'off';
      return `  ${wid}  ${key}  ${name}  ${grp}  ${status}  hits=${String(t.hitCount)}`;
    });

    // Fetch snapshot data for A-share codes only
    const aCodes = [...new Set(tasks.filter((t) => t.market === 'a').map((t) => t.code))];
    let byCode = new Map<string, StockSnapshotDto>();
    try {
      const snapshots = await this.stockMeta.snapshotAll(ctx.traceId);
      byCode = new Map(
        snapshots.filter((s) => aCodes.includes(s.meta.code)).map((s) => [s.meta.code, s]),
      );
    } catch {
      // Snapshot unavailable — show metadata only
    }

    const tableRows: StockTableRow[] = tasks.map((t) =>
      rowFromSnapshot({ code: t.code, name: t.name, snapshot: byCode.get(t.code) }),
    );

    const subheader = [`watch tasks (${String(tasks.length)}):`, ...metaLines].join('\n');
    const output = [subheader, '', formatStockTable(tableRows)].join('\n');
    return okResultWithMeta(output, {
      stockTableRows: stockTableMetaRows(tableRows),
      stockTableSubheader: subheader,
    });
  }
}
