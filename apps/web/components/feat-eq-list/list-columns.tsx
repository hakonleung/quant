'use client';

/**
 * Column-definition builders for EQ.LIST.
 *
 * Each column reads its value directly from a {@link ListRow} —
 * since the row is now BE-assembled by `useStockListRows` every
 * derived/return field is already on the row, no per-cell snapshot
 * lookup needed.
 */

import { Flex, Text } from '@chakra-ui/react';

import { type ColumnKey } from '../../lib/eqty/columns.catalog.js';
import {
  evidenceColumnKind,
  evidenceSortKey,
  formatEvidence,
  toNumberOrNull,
  type EvidenceColumnKind,
  type ListRow,
} from '../../lib/fp/eq-list-fp.js';

import { ChgPctCell, CnyCell, CnyDeltaCell, PctCell, PriceCell } from './list-cells.js';
import { STICKY_COL_WIDTH, type ColumnDef } from './list-types.js';

export function buildColumns(
  applied: readonly ColumnKey[],
  evidenceKeys: readonly string[],
): readonly ColumnDef[] {
  const out: ColumnDef[] = [];
  // CODE is always first + sticky regardless of user preference; the
  // dialog hides the toggle for it. We still render it from the
  // catalog entry so styling stays single-sourced.
  out.push(makeCodeColumn());
  for (const key of applied) {
    if (key === 'name') continue;
    const def = makeAppliedColumn(key);
    if (def !== null) out.push(def);
  }
  for (const k of evidenceKeys) {
    const kind = evidenceColumnKind(k);
    out.push({
      key: `ev:${k}`,
      label: k.toUpperCase(),
      w: 130,
      align: 'right',
      render: (r) => renderEvidenceCell(kind, r[k]),
      sortValue: (r) => evidenceSortKey(r[k]),
    });
  }
  return out;
}

function makeCodeColumn(): ColumnDef {
  return {
    key: 'name',
    label: 'CODE',
    w: STICKY_COL_WIDTH,
    align: 'left',
    sticky: true,
    render: (r) => (
      <Flex gap="6px" align="baseline" minW={0}>
        <Text
          fontFamily="mono"
          fontSize="11px"
          color="ink"
          fontWeight="600"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {r.name}
        </Text>
        <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.04em" flexShrink={0}>
          {r.code}
        </Text>
      </Flex>
    ),
    sortValue: (r) => r.name,
  };
}

function makeAppliedColumn(key: ColumnKey): ColumnDef | null {
  switch (key) {
    case 'name':
      return null; // handled by makeCodeColumn
    case 'price':
      return {
        key: 'price',
        label: 'PRICE',
        w: 90,
        align: 'right',
        render: (r) => <PriceCell pct={r.chgPct} price={r.statsReady ? r.price : null} />,
        sortValue: (r) => (r.statsReady ? r.price : null),
      };
    case 'chgPct':
      return {
        key: 'chgPct',
        label: 'CHG%',
        w: 90,
        align: 'right',
        render: (r) => <ChgPctCell value={r.chgPct} />,
        sortValue: (r) => r.chgPct,
      };
    case 'turnoverRate':
      return {
        key: 'turnoverRate',
        label: '换手',
        w: 90,
        align: 'right',
        render: (r) => <PctCell value={r.turnoverRate} />,
        sortValue: (r) => r.turnoverRate,
      };
    case 'turnover':
      return {
        key: 'turnover',
        label: '成交额',
        w: 110,
        align: 'right',
        render: (r) => <CnyCell value={r.turnover} />,
        sortValue: (r) => r.turnover,
      };
    case 'consecUp':
      return {
        key: 'consecUp',
        label: '连涨',
        w: 70,
        align: 'right',
        render: (r) => (
          <Text
            fontFamily="mono"
            fontSize="11px"
            color={r.statsReady && r.consecUpDays > 0 ? 'up' : 'ink3'}
          >
            {r.statsReady ? `${String(r.consecUpDays)}d` : '—'}
          </Text>
        ),
        sortValue: (r) => r.consecUpDays,
      };
    case 'ret5d':
      return returnColumn('ret5d', '5D%');
    case 'ret10d':
      return returnColumn('ret10d', '10D%');
    case 'ret20d':
      return returnColumn('ret20d', '20D%');
    case 'ret90d':
      return returnColumn('ret90d', '90D%');
    case 'ret250d':
      return returnColumn('ret250d', '250D%');
    case 'mktCap':
      return derivedColumn('mktCap', '总市值', 110, 'cny');
    case 'floatMktCap':
      return derivedColumn('floatMktCap', '流通市值', 110, 'cny');
    case 'peTtm':
      return derivedColumn('peTtm', 'PE-TTM', 90, 'ratio');
    case 'peDynamic':
      return derivedColumn('peDynamic', 'PE动态', 90, 'ratio');
    case 'pb':
      return derivedColumn('pb', 'PB', 70, 'ratio');
    case 'peg':
      return derivedColumn('peg', 'PEG', 70, 'ratio');
    case 'grossMargin':
      return derivedColumn('grossMargin', '毛利率', 90, 'pct');
    case 'ddeMainInflow3d':
      return derivedColumn('ddeMainInflow3d', '3日大单', 100, 'cny-delta');
    case 'ddeMainInflow5d':
      return derivedColumn('ddeMainInflow5d', '5日大单', 100, 'cny-delta');
    case 'ddeMainInflow10d':
      return derivedColumn('ddeMainInflow10d', '10日大单', 100, 'cny-delta');
    case 'ddeMainInflow20d':
      return derivedColumn('ddeMainInflow20d', '20日大单', 100, 'cny-delta');
    case 'ddeMainInflowRatio3d':
      return derivedColumn('ddeMainInflowRatio3d', '3日大单占比', 100, 'pct');
    case 'ddeMainInflowRatio5d':
      return derivedColumn('ddeMainInflowRatio5d', '5日大单占比', 100, 'pct');
    case 'ddeMainInflowRatio10d':
      return derivedColumn('ddeMainInflowRatio10d', '10日大单占比', 100, 'pct');
    case 'ddeMainInflowRatio20d':
      return derivedColumn('ddeMainInflowRatio20d', '20日大单占比', 100, 'pct');
  }
}

function readNumber(r: ListRow, key: ColumnKey): number | null {
  const v = (r as unknown as Record<string, unknown>)[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function derivedColumn(
  key: ColumnKey,
  label: string,
  w: number,
  format: 'cny' | 'cny-delta' | 'ratio' | 'pct',
): ColumnDef {
  const sortValue = (r: ListRow): number | null => readNumber(r, key);
  return {
    key,
    label,
    w,
    align: 'right',
    render: (r) => {
      const v = sortValue(r);
      if (v === null) {
        return (
          <Text fontFamily="mono" fontSize="11px" color="ink3">
            —
          </Text>
        );
      }
      if (format === 'cny') return <CnyCell value={v} />;
      if (format === 'cny-delta') return <CnyDeltaCell value={v} />;
      if (format === 'pct') return <ChgPctCell value={v} />;
      return (
        <Text fontFamily="mono" fontSize="11px" color="ink2">
          {v.toFixed(2)}
        </Text>
      );
    },
    sortValue,
  };
}

/**
 * Period-return column. Values on the row are already fractional
 * (e.g. `0.0532` for +5.32 %); pass straight to {@link ChgPctCell}
 * which handles the ×100 scaling.
 */
function returnColumn(key: ColumnKey, label: string): ColumnDef {
  return {
    key,
    label,
    w: 80,
    align: 'right',
    render: (r) => <ChgPctCell value={readNumber(r, key)} />,
    sortValue: (r) => readNumber(r, key),
  };
}

function renderEvidenceCell(kind: EvidenceColumnKind, raw: unknown): React.ReactNode {
  if (kind === 'cny') {
    return <CnyCell value={toNumberOrNull(raw)} />;
  }
  if (kind === 'chgPct') {
    return <ChgPctCell value={toNumberOrNull(raw)} />;
  }
  return (
    <Text fontFamily="mono" fontSize="11px" color="ink2">
      {formatEvidence(raw)}
    </Text>
  );
}
