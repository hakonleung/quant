import { Inject, Injectable } from '@nestjs/common';
import {
  StockArgsSchema,
  instructionId,
  okResult,
  okResultWithMeta,
  type InstructionResult,
  type StockListRow,
  type StockSnapshotDto,
} from '@quant/shared';
import type { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import {
  formatStockTable,
  stockTableMetaColumns,
  stockTableMetaRows,
} from '../domain/format-stock-table.js';
import { StockMetaService } from '../stock-meta.service.js';

const argsSchema = StockArgsSchema;
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
    let byCode: Map<string, StockSnapshotDto>;
    try {
      const snapshots = await this.stockMeta.snapshotAll(ctx.traceId);
      byCode = new Map(snapshots.map((s) => [s.meta.code, s]));
    } catch {
      byCode = new Map();
    }
    const rows: StockListRow[] = matches.map((m) => buildRow(m.code, m.name, byCode.get(m.code)));
    const text = `${subheader}\n\n${formatStockTable(rows)}`;
    return okResultWithMeta(text, {
      stockTableColumns: stockTableMetaColumns(),
      stockTableRows: stockTableMetaRows(rows),
      stockTableSubheader: subheader,
    });
  }
}

function buildRow(code: string, name: string, snap: StockSnapshotDto | undefined): StockListRow {
  return {
    code,
    name,
    price: parseDecimal(snap?.price),
    chgPct: parseDecimal(snap?.returns.ret_1d),
    turnoverRate: null,
    turnover: null,
    consecUp: null,
    ret5d: parseDecimal(snap?.returns.ret_5d),
    ret10d: parseDecimal(snap?.returns.ret_10d),
    ret20d: parseDecimal(snap?.returns.ret_20d),
    ret90d: parseDecimal(snap?.returns.ret_90d),
    ret250d: parseDecimal(snap?.returns.ret_250d),
    mktCap: parseDecimal(snap?.derived.mkt_cap),
    floatMktCap: parseDecimal(snap?.derived.float_mkt_cap),
    peTtm: parseDecimal(snap?.derived.pe_ttm),
    peDynamic: parseDecimal(snap?.derived.pe_dynamic),
    pb: parseDecimal(snap?.derived.pb),
    peg: parseDecimal(snap?.derived.peg),
    grossMargin: parseDecimal(snap?.derived.gross_margin_ttm),
  };
}

function parseDecimal(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
