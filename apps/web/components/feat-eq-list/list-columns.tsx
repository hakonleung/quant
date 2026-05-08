'use client';

/**
 * Column-definition builders for EQ.LIST.
 *
 * Each column knows: width, label, alignment, optional stickiness,
 * how to render its cell from a {@link ListRow}, and how to extract
 * its sortable value. `buildColumns` composes the user's applied
 * columns + dynamic-sector evidence keys into the final array the
 * ScrollGrid renders.
 *
 * Lifted out of `feat-eq-list.tsx` so the orchestrator stays under
 * the 400-line ceiling and so column heuristics (which key drives
 * which cell formatter) live next to the data shape they describe.
 */

import { Flex, Text } from '@chakra-ui/react';
import type { StockSnapshotDto } from '@quant/shared';

import {
  appliedNeedsSnapshot,
  getColumnSpec,
  type ColumnKey,
} from '../../lib/eqty/columns.catalog.js';
import {
  evidenceColumnKind,
  evidenceSortKey,
  formatEvidence,
  toNumberOrNull,
  type EvidenceColumnKind,
} from '../../lib/fp/eq-list-fp.js';

import { ChgPctCell, CnyCell, PctCell, PriceCell } from './list-cells.js';
import { STICKY_COL_WIDTH, type ColumnDef } from './list-types.js';

export { appliedNeedsSnapshot };

export function buildColumns(
  applied: readonly ColumnKey[],
  evidenceKeys: readonly string[],
  snapshotByCode: ReadonlyMap<string, StockSnapshotDto>,
): readonly ColumnDef[] {
  const out: ColumnDef[] = [];
  // CODE is always first + sticky regardless of user preference; the
  // dialog hides the toggle for it. We still render it from the
  // catalog entry so styling stays single-sourced.
  out.push(makeCodeColumn());
  for (const key of applied) {
    if (key === 'name') continue;
    const def = makeAppliedColumn(key, snapshotByCode);
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

function makeAppliedColumn(
  key: ColumnKey,
  snapshotByCode: ReadonlyMap<string, StockSnapshotDto>,
): ColumnDef | null {
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
    case 'mktCap':
      return derivedColumn('mktCap', '总市值', 110, snapshotByCode, (d) => d.mkt_cap, 'cny');
    case 'floatMktCap':
      return derivedColumn(
        'floatMktCap',
        '流通市值',
        110,
        snapshotByCode,
        (d) => d.float_mkt_cap,
        'cny',
      );
    case 'peTtm':
      return derivedColumn('peTtm', 'PE-TTM', 90, snapshotByCode, (d) => d.pe_ttm, 'ratio');
    case 'peDynamic':
      return derivedColumn(
        'peDynamic',
        'PE动态',
        90,
        snapshotByCode,
        (d) => d.pe_dynamic,
        'ratio',
      );
    case 'pb':
      return derivedColumn('pb', 'PB', 70, snapshotByCode, (d) => d.pb, 'ratio');
    case 'peg':
      return derivedColumn('peg', 'PEG', 70, snapshotByCode, (d) => d.peg, 'ratio');
    case 'grossMargin':
      return derivedColumn(
        'grossMargin',
        '毛利率',
        90,
        snapshotByCode,
        (d) => d.gross_margin_ttm,
        'pct',
      );
  }
}

function derivedColumn(
  key: ColumnKey,
  label: string,
  w: number,
  snapshotByCode: ReadonlyMap<string, StockSnapshotDto>,
  pick: (d: StockSnapshotDto['derived']) => string | null,
  format: 'cny' | 'ratio' | 'pct',
): ColumnDef {
  const sortValue = (code: string): number | null => {
    const snap = snapshotByCode.get(code);
    if (snap === undefined) return null;
    const raw = pick(snap.derived);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const spec = getColumnSpec(key);
  return {
    key: spec.key,
    label,
    w,
    align: 'right',
    render: (r) => {
      const v = sortValue(r.code);
      if (v === null) {
        return (
          <Text fontFamily="mono" fontSize="11px" color="ink3">
            —
          </Text>
        );
      }
      if (format === 'cny') return <CnyCell value={v} />;
      if (format === 'pct') return <ChgPctCell value={v} />;
      return (
        <Text fontFamily="mono" fontSize="11px" color="ink2">
          {v.toFixed(2)}
        </Text>
      );
    },
    sortValue: (r) => sortValue(r.code),
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
