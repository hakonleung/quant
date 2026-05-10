/**
 * `/sector show <idOrName>` — print one sector's basic info + stock table.
 *
 * The IM table mirrors the frontend EQ.LIST default columns (code, name,
 * price, chg%, 换手, 成交额, 连涨, 5d%, 20d%, 90d%, 250d%) so users
 * working in Feishu see the same shape as the web pane. Fields the
 * snapshot endpoint doesn't carry (turnoverRate / turnover / consecUp
 * — those are kline-derived) render as `—`. For dynamic sectors we
 * append one extra column per evaluator-evidence key so screening
 * results show their underlying metric inline.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  okResultWithMeta,
  QuantError,
  type InstructionResult,
  type Sector,
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
  stockTableMetaColumns,
  stockTableMetaRows,
  type StockTableRow,
} from '../../stock-meta/domain/format-stock-table.js';
import { SectorsService } from '../sectors.service.js';

// 30 rows of the code-fenced stock table fits comfortably under
// `truncateForCard`'s 3000-char ceiling.
const MAX_TABLE_ROWS = 30;

const argsSchema = z
  .object({ id: z.string().min(1).describe('Sector id (e.g. s1) or sector name') })
  .strict();
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
    examples: ['sector.show s1', 'sector.show 白酒'],
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

    const evidenceKeys = collectEvidenceKeys(sector, codes);

    let rows: StockTableRow[] | null = null;
    let tableText: string;
    try {
      const allSnapshots = await this.stockMeta.snapshotAll(ctx.traceId);
      const byCode = new Map<string, StockSnapshotDto>(allSnapshots.map((s) => [s.meta.code, s]));
      rows = codes.map((code) => buildRow(code, byCode.get(code), sector, evidenceKeys));
      tableText = formatStockTable(rows);
    } catch {
      tableText = codes.join(', ');
    }

    const text = `${headerLine}\n\n${tableText}${tail}`;
    if (rows === null) return okResult(text);
    return okResultWithMeta(text, {
      stockTableColumns: stockTableMetaColumns(evidenceKeys),
      stockTableRows: stockTableMetaRows(rows, evidenceKeys),
      stockTableSubheader: `${headerLine}${tail.length > 0 ? `  ·  ${tail.trim()}` : ''}`,
    });
  }
}

function buildRow(
  code: string,
  snap: StockSnapshotDto | undefined,
  sector: Sector,
  evidenceKeys: readonly string[],
): StockTableRow {
  const evidence = pickEvidence(sector, code, evidenceKeys);
  return rowFromSnapshot({
    code,
    name: snap?.meta.name ?? code,
    snapshot: snap,
    evidence,
  });
}

function pickEvidence(
  sector: Sector,
  code: string,
  evidenceKeys: readonly string[],
): Readonly<Record<string, string | null>> {
  const raw =
    sector.kind === 'dynamic' && sector.evidence !== undefined
      ? (sector.evidence[code] ?? {})
      : {};
  const out: Record<string, string | null> = {};
  for (const k of evidenceKeys) out[k] = formatEvidenceValue(raw[k]);
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
