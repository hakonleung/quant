/**
 * `/sector show <idOrName>` — print one sector's basic info + stock table.
 * Fetches the full snapshot universe (60 s SWR cache) and joins on sector
 * codes so IM users see price + multi-period returns inline.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  okResultWithMeta,
  QuantError,
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
  stockTableMetaRows,
  type StockTableRow,
} from '../../stock-meta/domain/format-stock-table.js';
import { SectorsService } from '../sectors.service.js';

// 30 rows of the code-fenced stock table fits comfortably under
// `truncateForCard`'s 3000-char ceiling. Bumping this any higher risks
// the truncate cutting the closing ``` fence and the entire table
// rendering as inline-style text in Feishu.
const MAX_TABLE_ROWS = 30;

const argsSchema = z
  .object({ id: z.string().min(1).describe('Sector id (e.g. s1) or sector name') })
  .strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class SectorShowInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('sector.show'),
    summary: 'Show one sector: stock table with price + period returns.',
    summaryCn: '查看板块股票列表（价格 + 涨跌幅）',
    group: 'market',
    argsSchema,
    positional: ['id'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(SectorsService) private readonly sectors: SectorsService,
    @Inject(StockMetaService) private readonly stockMeta: StockMetaService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    let sector;
    try {
      sector = this.sectors.resolveVisible(ctx.userId, args.id);
    } catch (err) {
      if (err instanceof QuantError && err.code === 'NOT_FOUND') {
        return errResult('not-found', err.message);
      }
      throw err;
    }

    const headerLine = [
      `${sector.id}  ${sector.name}  [${sector.kind}]`,
      `by ${sector.createdBy === ctx.userId ? 'me' : sector.createdBy}`,
      sector.published ? '[PUB]' : '',
      `count=${String(sector.count)}`,
    ]
      .filter(Boolean)
      .join('  ');

    const codes = sector.codes.slice(0, MAX_TABLE_ROWS);
    const tail =
      sector.codes.length > MAX_TABLE_ROWS
        ? `\n(+${String(sector.codes.length - MAX_TABLE_ROWS)} more)`
        : '';

    let rows: StockTableRow[] | null = null;
    let tableText: string;
    try {
      const allSnapshots = await this.stockMeta.snapshotAll(ctx.traceId);
      const byCode = new Map<string, StockSnapshotDto>(allSnapshots.map((s) => [s.meta.code, s]));
      rows = codes.map((code) => {
        const snap = byCode.get(code);
        return {
          code,
          name: snap?.meta.name ?? code,
          price: snap?.price ?? null,
          ret_1d: snap?.returns.ret_1d ?? null,
          ret_20d: snap?.returns.ret_20d ?? null,
          ret_90d: snap?.returns.ret_90d ?? null,
          ret_250d: snap?.returns.ret_250d ?? null,
        };
      });
      tableText = formatStockTable(rows);
    } catch {
      // Fallback: snapshot fetch failed, show code list only.
      // No structured rows in this branch — Feishu falls back to the
      // legacy markdown card automatically when `stockTableRows` is absent.
      tableText = codes.join(', ');
    }

    const text = `${headerLine}\n\n${tableText}${tail}`;
    if (rows === null) return okResult(text);
    // Surface the structured rows on `output.meta` so the Feishu adapter
    // upgrades the card to the schema-2.0 native `table` element. Slack
    // and the term widget ignore the meta and render `text`.
    return okResultWithMeta(text, {
      stockTableRows: stockTableMetaRows(rows),
      stockTableSubheader: `${headerLine}${tail.length > 0 ? `  ·  ${tail.trim()}` : ''}`,
    });
  }
}
