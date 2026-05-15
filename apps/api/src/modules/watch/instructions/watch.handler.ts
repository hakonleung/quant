/**
 * `watch` / `watch.list` — list every registered watch task with its
 * w-index, market:code, group, status, and stock-table rows.
 *
 * Row assembly delegates to `StockListService.assembleRows({ kind: 'watch' })`,
 * matching the FE list pane and `sector.show`. A-share codes only —
 * non-A tasks have no snapshot to render.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  instructionId,
  okResult,
  okResultWithMeta,
  type InstructionResult,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import {
  formatStockTable,
  stockTableMetaRows,
} from '../../stock-meta/domain/format-stock-table.js';
import { StockListService } from '../../stock-list/stock-list.service.js';
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
    @Inject(StockListService) private readonly stockList: StockListService,
  ) {
    super(registry);
  }

  async execute(_args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const tasks = await this.watch.list(ctx.userId);
    if (tasks.length === 0) return okResult('no watch tasks');

    const metaLines = tasks.map((t) => {
      const wid = `w${String(t.idx)}`.padEnd(4);
      const key = `${t.market}:${t.code}`.padEnd(10);
      const name = t.name.slice(0, 8).padEnd(8);
      const grp = `grp=${t.groupName}`.padEnd(16);
      const status = t.enabled ? 'on ' : 'off';
      return `  ${wid}  ${key}  ${name}  ${grp}  ${status}  hits=${String(t.hitCount)}`;
    });

    const aCodes = [...new Set(tasks.filter((t) => t.market === 'a').map((t) => t.code))];
    const subheader = [`watch tasks (${String(tasks.length)}):`, ...metaLines].join('\n');

    if (aCodes.length === 0) {
      return okResult(subheader);
    }

    try {
      const out = await this.stockList.assembleRows({
        kind: 'watch',
        codes: aCodes,
        traceId: ctx.traceId,
      });
      const output = [subheader, '', formatStockTable(out.rows)].join('\n');
      return okResultWithMeta(output, {
        stockTableRows: stockTableMetaRows(out.rows),
        stockTableSubheader: subheader,
      });
    } catch {
      return okResult(subheader);
    }
  }
}
