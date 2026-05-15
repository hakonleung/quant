/**
 * `/sector show <idOrName>` — print one sector's basic info + stock table.
 *
 * Row assembly is delegated to `StockListService.assembleRows({ kind: 'user-sector' | 'dynamic-sector' })`,
 * which is the same composition the FE list pane uses. Evidence keys
 * for dynamic sectors are pre-formatted here and threaded through
 * `evidenceByCode` so they appear as extra columns on every row.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  SectorShowArgsSchema,
  errResult,
  instructionId,
  okResult,
  okResultWithMeta,
  QuantError,
  type InstructionResult,
  type Sector,
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
} from '../../stock-meta/domain/format-stock-table.js';
import { StockListService } from '../../stock-list/stock-list.service.js';
import { SectorsService } from '../sectors.service.js';

const MAX_TABLE_ROWS = 30;

const argsSchema = SectorShowArgsSchema;
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class SectorShowInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('sector.show'),
    summary: 'Show one sector: stock table aligned with the frontend EQ.LIST columns.',
    summaryCn: '查看板块股票列表（列与前端 mkt 列表一致；动态板块附带 evidence 列）',
    group: 'market',
    argsSchema,
    positional: ['id'],
    imAliases: ['查看板块', '板块详情'],
    examples: ['sector.show s1', 'sector.show 白酒'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(SectorsService) private readonly sectors: SectorsService,
    @Inject(StockListService) private readonly stockList: StockListService,
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

    const evidenceKeys = collectEvidenceKeys(sector, codes);
    const evidenceByCode = buildEvidenceByCode(sector, codes, evidenceKeys);

    let tableText: string;
    try {
      const out = await this.stockList.assembleRows({
        kind: sector.kind === 'dynamic' ? 'dynamic-sector' : 'user-sector',
        codes,
        traceId: ctx.traceId,
        ...(Object.keys(evidenceByCode).length > 0 ? { evidenceByCode } : {}),
      });
      tableText = formatStockTable(out.rows);
      const text = `${headerLine}\n\n${tableText}${tail}`;
      return okResultWithMeta(text, {
        stockTableColumns: stockTableMetaColumns(evidenceKeys),
        stockTableRows: stockTableMetaRows(out.rows, evidenceKeys),
        stockTableSubheader: `${headerLine}${tail.length > 0 ? `  ·  ${tail.trim()}` : ''}`,
      });
    } catch {
      tableText = codes.join(', ');
      return okResult(`${headerLine}\n\n${tableText}${tail}`);
    }
  }
}

function buildEvidenceByCode(
  sector: Sector,
  codes: readonly string[],
  evidenceKeys: readonly string[],
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  if (sector.kind !== 'dynamic' || sector.evidence === undefined) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const code of codes) {
    const inner = sector.evidence[code];
    if (inner === undefined) continue;
    const formatted: Record<string, string> = {};
    for (const k of evidenceKeys) {
      const v = formatEvidenceValue(inner[k]);
      if (v !== null) formatted[k] = v;
    }
    if (Object.keys(formatted).length > 0) out[code] = formatted;
  }
  return out;
}

function collectEvidenceKeys(sector: Sector, codes: readonly string[]): readonly string[] {
  if (sector.kind !== 'dynamic' || sector.evidence === undefined) return [];
  const seen = new Set<string>();
  for (const code of codes) {
    const inner = sector.evidence[code];
    if (inner === undefined) continue;
    for (const k of Object.keys(inner)) seen.add(k);
  }
  return [...seen].sort();
}

function formatEvidenceValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.abs(raw) < 1 ? raw.toFixed(4) : raw.toFixed(2);
  }
  if (typeof raw === 'string') return raw.length > 0 ? raw : null;
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return null;
}
