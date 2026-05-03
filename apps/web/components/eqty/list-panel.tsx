'use client';

/**
 * Module 07 §workbench — List (Feat 001).
 *
 * Renders the active-sector membership as a sortable table.
 *
 * Header switches by sector kind:
 *   - "All" / user — name+code filter input.
 *   - dynamic      — read-only NL replay + parsed DSL tree.
 *
 * Columns:
 *   1) name + code (stacked)
 *   2) chgPct · turnoverRate · turnover (成交额) · consecUp days
 *   3) for dynamic: union of evaluator-evidence keys (one per column)
 * All columns are sortable.
 */

import { Box, Flex, Input, Text } from '@chakra-ui/react';
import type { StockMetaDto } from '@quant/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { deriveStats, type StockStats } from '../../lib/fp/stock-stats.js';
import { useKline } from '../../lib/hooks/use-eqty-data.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { Pane } from '../shell/pane.js';

interface ListRow {
  readonly code: string;
  readonly name: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

interface SortState {
  readonly key: string;
  readonly dir: 'asc' | 'desc';
}

export function ListPanel(): React.ReactElement {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const setFocusCode = useUiStore((s) => s.setFocusCode);
  const focusCode = useUiStore((s) => s.focusCode);
  const sectors = useSectorsStore((s) => s.sectors);

  const { data, isLoading, error } = useStockList();
  const universe = data ?? [];
  const ready = useMemo(() => universe.filter((s) => s.industries !== ''), [universe]);
  const universeByCode = useMemo(() => {
    const m = new Map<string, StockMetaDto>();
    for (const r of ready) m.set(r.code, r);
    return m;
  }, [ready]);

  const sector = sectors.find((s) => s.id === activeSectorId) ?? null;
  const isAll = activeSectorId === ALL_SECTOR_ID;
  const isDynamic = sector !== null && sector.kind === 'dynamic';

  const baseRows: readonly ListRow[] = useMemo(() => {
    if (isAll) {
      return ready.map((r) => ({ code: r.code, name: r.name, evidence: {} }));
    }
    if (sector === null) return [];
    const evidenceMap = sector.evidence ?? {};
    return sector.codes.map((code) => {
      const meta = universeByCode.get(code);
      return {
        code,
        name: meta?.name ?? code,
        evidence: evidenceMap[code] ?? {},
      };
    });
  }, [isAll, sector, ready, universeByCode]);

  const evidenceKeys: readonly string[] = useMemo(() => {
    if (!isDynamic) return [];
    const seen = new Set<string>();
    for (const r of baseRows) for (const k of Object.keys(r.evidence)) seen.add(k);
    return [...seen].sort();
  }, [isDynamic, baseRows]);

  const [filter, setFilter] = useState('');
  const filteredRows: readonly ListRow[] = useMemo(() => {
    if (isDynamic) return baseRows;
    const q = filter.trim().toLowerCase();
    if (q === '') return baseRows;
    return baseRows.filter((r) => r.code.startsWith(q) || r.name.toLowerCase().includes(q));
  }, [baseRows, filter, isDynamic]);

  const [sort, setSort] = useState<SortState | null>(null);
  const sortedRows: readonly ListRow[] = useMemo(() => {
    if (sort === null) return filteredRows;
    const arr = [...filteredRows];
    arr.sort((a, b) => compareRows(a, b, sort.key));
    if (sort.dir === 'desc') arr.reverse();
    return arr;
  }, [filteredRows, sort]);

  const columns: readonly ColumnDef[] = useMemo(() => buildColumns(evidenceKeys), [evidenceKeys]);

  const right =
    error !== null && error !== undefined ? (
      <Text color="up">// {(error as Error).message}</Text>
    ) : isLoading ? (
      <Text>loading…</Text>
    ) : (
      <Text>
        {focusCode === null ? '— no selection' : `▎ ${focusCode}`} · {sortedRows.length} rows
      </Text>
    );

  return (
    <Pane feat={Feat.List} right={right}>
      <Flex direction="column" h="100%" minH={0}>
        {isDynamic ? (
          <DynamicHeader sector={sector} />
        ) : (
          <FilterHeader
            filter={filter}
            setFilter={setFilter}
            total={baseRows.length}
            hits={filteredRows.length}
          />
        )}
        <ColumnHeader columns={columns} sort={sort} setSort={setSort} />
        <VirtualBody
          rows={sortedRows}
          columns={columns}
          focusedCode={focusCode}
          onRowClick={(row): void => {
            setFocusCode(row.code);
          }}
          emptyHint={
            isAll
              ? 'universe empty (run an orchestrator sync)'
              : isDynamic
                ? 'no dynamic hits'
                : 'sector has no members'
          }
        />
      </Flex>
    </Pane>
  );
}

function FilterHeader({
  filter,
  setFilter,
  total,
  hits,
}: {
  filter: string;
  setFilter: (v: string) => void;
  total: number;
  hits: number;
}): React.ReactElement {
  return (
    <Flex
      align="center"
      gap="10px"
      px="14px"
      py="8px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
      flexShrink={0}
    >
      <Text color="prompt" fontFamily="mono" fontSize="12px" fontWeight="700">
        $
      </Text>
      <Input
        value={filter}
        onChange={(e): void => {
          setFilter(e.target.value);
        }}
        placeholder="filter --code|name"
        bg="panel"
        borderWidth="1px"
        borderColor="line"
        h="28px"
        px="10px"
        fontFamily="mono"
        fontSize="12px"
        borderRadius="0"
        _focus={{ borderColor: 'accent', boxShadow: 'none' }}
      />
      <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.14em">
        {hits}/{total}
      </Text>
    </Flex>
  );
}

function DynamicHeader({ sector }: { sector: Sector }): React.ReactElement {
  return (
    <Flex
      direction="column"
      gap="8px"
      px="14px"
      py="10px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
      flexShrink={0}
    >
      <Flex align="center" gap="8px">
        <Text color="prompt" fontFamily="mono" fontSize="12px" fontWeight="700">
          $
        </Text>
        <Text
          fontFamily="mono"
          fontSize="12px"
          color="ink"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {sector.nl ?? sector.meta}
        </Text>
      </Flex>
    </Flex>
  );
}

interface ColumnDef {
  readonly key: string;
  readonly label: string;
  readonly w: string;
  readonly align: 'left' | 'right';
  readonly render: (row: ListRow, stats: StockStats | null) => React.ReactNode;
  readonly sortValue: (row: ListRow) => number | string;
}

function buildColumns(evidenceKeys: readonly string[]): readonly ColumnDef[] {
  const base: ColumnDef[] = [
    {
      key: 'name',
      label: 'CODE',
      w: '180px',
      align: 'left',
      render: (r) => (
        <Box>
          <Text fontFamily="mono" fontSize="12px" color="ink" fontWeight="600">
            {r.name}
          </Text>
          <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.06em">
            {r.code}
          </Text>
        </Box>
      ),
      sortValue: (r) => r.name,
    },
    {
      key: 'price',
      label: 'PRICE',
      w: '90px',
      align: 'right',
      render: (_r, s) => <PriceCell pct={s?.chgPct ?? null} price={s?.price} />,
      sortValue: () => 0,
    },
    {
      key: 'chgPct',
      label: 'CHG%',
      w: '90px',
      align: 'right',
      render: (_r, s) => <ChgPctCell value={s?.chgPct ?? null} />,
      sortValue: () => 0,
    },
    {
      key: 'turnoverRate',
      label: '换手',
      w: '90px',
      align: 'right',
      render: (_r, s) => <PctCell value={s?.turnoverRate ?? null} />,
      sortValue: () => 0,
    },
    {
      key: 'turnover',
      label: '成交额',
      w: '110px',
      align: 'right',
      render: (_r, s) => <CnyCell value={s?.turnover ?? null} />,
      sortValue: () => 0,
    },
    {
      key: 'consecUp',
      label: '连涨',
      w: '70px',
      align: 'right',
      render: (_r, s) => (
        <Text
          fontFamily="mono"
          fontSize="11px"
          color={s !== null && s.consecUpDays > 0 ? 'up' : 'ink3'}
        >
          {s === null ? '—' : `${s.consecUpDays}d`}
        </Text>
      ),
      sortValue: () => 0,
    },
  ];
  for (const k of evidenceKeys) {
    base.push({
      key: `ev:${k}`,
      label: k.toUpperCase(),
      w: 'minmax(110px, 1fr)',
      align: 'right',
      render: (r) => (
        <Text fontFamily="mono" fontSize="11px" color="ink2">
          {formatEvidence(r.evidence[k])}
        </Text>
      ),
      sortValue: (r) => evidenceSortKey(r.evidence[k]),
    });
  }
  return base;
}

function ColumnHeader({
  columns,
  sort,
  setSort,
}: {
  columns: readonly ColumnDef[];
  sort: SortState | null;
  setSort: (s: SortState | null) => void;
}): React.ReactElement {
  return (
    <Box
      display="grid"
      gridTemplateColumns={columns.map((c) => c.w).join(' ')}
      gap="0"
      bg="panel3"
      borderBottomWidth="1px"
      borderColor="line"
      flexShrink={0}
    >
      {columns.map((c) => {
        const active = sort?.key === c.key;
        const arrow = !active ? '' : sort.dir === 'asc' ? ' ▲' : ' ▼';
        return (
          <Box
            as="button"
            key={c.key}
            onClick={(): void => {
              if (!active) {
                setSort({ key: c.key, dir: 'asc' });
              } else if (sort.dir === 'asc') {
                setSort({ key: c.key, dir: 'desc' });
              } else {
                setSort(null);
              }
            }}
            px="10px"
            py="6px"
            textAlign={c.align}
            color={active ? 'accent' : 'ink3'}
            fontFamily="mono"
            fontSize="10px"
            letterSpacing="0.16em"
            textTransform="uppercase"
            fontWeight="700"
            bg="transparent"
            cursor="pointer"
            _hover={{ color: 'accent' }}
          >
            {c.label}
            {arrow}
          </Box>
        );
      })}
    </Box>
  );
}

interface BodyProps {
  readonly rows: readonly ListRow[];
  readonly columns: readonly ColumnDef[];
  readonly focusedCode: string | null;
  readonly onRowClick: (row: ListRow) => void;
  readonly emptyHint: string;
}

function VirtualBody({
  rows,
  columns,
  focusedCode,
  onRowClick,
  emptyHint,
}: BodyProps): React.ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 38,
    overscan: 12,
  });
  if (rows.length === 0) {
    return (
      <Box flex="1" overflow="auto" px="14px" py="14px">
        <Text fontFamily="mono" fontSize="11px" color="ink3" letterSpacing="0.12em">
          // {emptyHint}
        </Text>
      </Box>
    );
  }
  const cols = columns.map((c) => c.w).join(' ');
  return (
    <Box ref={parentRef} flex="1" overflow="auto">
      <Box position="relative" h={`${String(rowVirtualizer.getTotalSize())}px`}>
        {rowVirtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (row === undefined) return null;
          return (
            <RowItem
              key={vi.key}
              row={row}
              columns={columns}
              cols={cols}
              top={vi.start}
              h={vi.size}
              focused={focusedCode !== null && row.code === focusedCode}
              onClick={(): void => {
                onRowClick(row);
              }}
            />
          );
        })}
      </Box>
    </Box>
  );
}

interface RowItemProps {
  readonly row: ListRow;
  readonly columns: readonly ColumnDef[];
  readonly cols: string;
  readonly top: number;
  readonly h: number;
  readonly focused: boolean;
  readonly onClick: () => void;
}

/**
 * Per-row component. Calls `useKline(code, '30D')` lazily — only rows
 * the virtualizer mounts trigger fetches, so the network cost scales
 * with the visible viewport, not the universe size.
 */
function RowItem({
  row,
  columns,
  cols,
  top,
  h,
  focused,
  onClick,
}: RowItemProps): React.ReactElement {
  const { data } = useKline(row.code, '30D');
  const stats: StockStats | null = data === undefined ? null : deriveStats(data);
  return (
    <Box
      position="absolute"
      top={0}
      left={0}
      right={0}
      transform={`translateY(${String(top)}px)`}
      h={`${String(h)}px`}
      display="grid"
      gridTemplateColumns={cols}
      alignItems="center"
      borderBottomWidth="1px"
      borderColor="line2"
      borderLeftWidth={focused ? '2px' : 0}
      borderLeftColor="accent"
      bg={focused ? 'accentBg' : 'transparent'}
      cursor="pointer"
      _hover={focused ? {} : { bg: 'hover' }}
      onClick={onClick}
    >
      {columns.map((c) => (
        <Box key={c.key} px="10px" py="4px" textAlign={c.align} overflow="hidden">
          {c.render(row, stats)}
        </Box>
      ))}
    </Box>
  );
}

function PriceCell({
  pct,
  price,
}: {
  pct: number | null;
  price: number | undefined;
}): React.ReactElement {
  if (pct === null) {
    return (
      <Text fontFamily="mono" fontSize="11px" color="ink3">
        —
      </Text>
    );
  }
  const color = pct > 0 ? 'up' : pct < 0 ? 'down' : 'ink3';
  return (
    <Text fontFamily="mono" fontSize="11px" color={color} fontWeight="600">
      {price?.toFixed(2)}
    </Text>
  );
}

function ChgPctCell({ value }: { value: number | null }): React.ReactElement {
  if (value === null) {
    return (
      <Text fontFamily="mono" fontSize="11px" color="ink3">
        —
      </Text>
    );
  }
  const pct = value * 100;
  const color = pct > 0 ? 'up' : pct < 0 ? 'down' : 'ink3';
  const sign = pct > 0 ? '+' : '';
  return (
    <Text fontFamily="mono" fontSize="11px" color={color} fontWeight="600">
      {sign}
      {pct.toFixed(2)}%
    </Text>
  );
}

function PctCell({ value }: { value: number | null }): React.ReactElement {
  return (
    <Text fontFamily="mono" fontSize="11px" color={value === null ? 'ink3' : 'ink2'}>
      {value === null ? '—' : `${(value * 100).toFixed(2)}%`}
    </Text>
  );
}

function CnyCell({ value }: { value: number | null }): React.ReactElement {
  if (value === null) {
    return (
      <Text fontFamily="mono" fontSize="11px" color="ink3">
        —
      </Text>
    );
  }
  // Format CNY notional in 亿 / 万 — list-panel rows are too narrow for
  // raw scientific notation.
  const yi = 1e8;
  const wan = 1e4;
  const text =
    value >= yi
      ? `${(value / yi).toFixed(2)}亿`
      : value >= wan
        ? `${(value / wan).toFixed(0)}万`
        : value.toFixed(0);
  return (
    <Text fontFamily="mono" fontSize="11px" color="ink2">
      {text}
    </Text>
  );
}

function compareRows(a: ListRow, b: ListRow, key: string): number {
  // Look up the column's sortValue via key prefix (evidence cols are
  // namespaced; built-ins use direct keys).
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb));
}

function sortValue(r: ListRow, key: string): number | string {
  if (key === 'name') return r.name;
  if (key === 'code') return r.code;
  if (key.startsWith('ev:')) {
    const k = key.slice(3);
    return evidenceSortKey(r.evidence[k]);
  }
  // Placeholder columns (chgPct/turnoverRate/turnover/consecUp) — no
  // server data yet, so sorting is a no-op.
  return 0;
}

function evidenceSortKey(v: unknown): number | string {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return Number.NEGATIVE_INFINITY;
  return String(v);
}

function formatEvidence(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v);
}
