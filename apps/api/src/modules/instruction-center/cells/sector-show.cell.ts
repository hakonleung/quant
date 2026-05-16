/**
 * `/sector.show <idOrName>` cell — single-sector detail with the
 * frontend-aligned stock table + dynamic-sector evidence columns.
 *
 * Handler resolves the sector via `SectorsService.resolveVisible`,
 * caps the displayed slice at MAX_TABLE_ROWS, pre-formats evidence
 * values for dynamic sectors, then assembles the snapshot rows. Row
 * assembly failures degrade `stockRows` to `null` (renderer falls
 * back to a code list).
 *
 * `QuantError(NOT_FOUND)` from resolveVisible → `not-found` envelope.
 */

import {
  InstructionDispatchError,
  QuantError,
  type InstructionCell,
  type ResultOf,
  type Sector,
} from '@quant/shared';

import { SectorsService } from '../../sectors/sectors.service.js';
import { StockListService } from '../../stock-list/stock-list.service.js';
import type { BeEnv } from '../be-types.js';
import { renderSectorShow } from './sector-show.render.js';

type SectorShowResult = ResultOf<'sector.show'>;

const MAX_TABLE_ROWS = 30;

export interface SectorShowCellDeps {
  readonly sectors: SectorsService;
  readonly stockList: StockListService;
}

export function buildSectorShowCell(
  deps: SectorShowCellDeps,
): InstructionCell<BeEnv, 'sector.show'> {
  return {
    async handler(args, ctx): Promise<SectorShowResult> {
      let sector: Sector;
      try {
        sector = deps.sectors.resolveVisible(ctx.userId, args.id);
      } catch (err) {
        if (err instanceof QuantError && err.code === 'NOT_FOUND') {
          throw new InstructionDispatchError('not-found', err.message);
        }
        throw err;
      }

      const codes = sector.codes.slice(0, MAX_TABLE_ROWS);
      const evidenceKeys = collectEvidenceKeys(sector, codes);
      const evidenceByCode = buildEvidenceByCode(sector, codes, evidenceKeys);

      let stockRows: SectorShowResult['stockRows'];
      try {
        const out = await deps.stockList.assembleRows({
          kind: sector.kind === 'dynamic' ? 'dynamic-sector' : 'user-sector',
          codes,
          traceId: ctx.traceId,
          ...(Object.keys(evidenceByCode).length > 0 ? { evidenceByCode } : {}),
        });
        stockRows = out.rows;
      } catch {
        stockRows = null;
      }

      return {
        id: sector.id,
        name: sector.name,
        kind: sector.kind,
        createdBy: sector.createdBy,
        isOwn: sector.createdBy === ctx.userId,
        published: sector.published,
        totalCount: sector.codes.length,
        codes,
        stockRows,
        evidenceKeys: [...evidenceKeys],
        evidenceByCode,
      };
    },
    renderer(envelope) {
      return renderSectorShow(envelope);
    },
  };
}

function buildEvidenceByCode(
  sector: Sector,
  codes: readonly string[],
  evidenceKeys: readonly string[],
): Record<string, Record<string, string>> {
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
