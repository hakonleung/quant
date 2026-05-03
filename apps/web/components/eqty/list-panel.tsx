'use client';

/**
 * Module 07 §workbench — List (Feat 001).
 *
 * Pre-fetches kline (30D) for every visible code via
 * `useKlineByCodes` so sortable metric columns operate on real data.
 * Evidence values from dynamic sectors are flattened onto the row so
 * sortValue reads them directly.
 *
 * The first column (CODE) is sticky during horizontal scroll; the
 * column header scrolls in lock-step inside a single horizontally
 * scrollable container.
 */

import { Box, Flex, Input, Text } from '@chakra-ui/react';
import type { KlineBar, StockMetaDto } from '@quant/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { deriveStats, type StockStats } from '../../lib/fp/stock-stats.js';
import { useKlineBulk } from '../../lib/hooks/use-eqty-data.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { Pane } from '../shell/pane.js';

interface ListRow extends StockStats {
  readonly code: string;
  readonly name: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly statsReady: boolean;
}

interface SortState {
  readonly key: string;
  readonly dir: 'asc' | 'desc';
}

const STICKY_COL_WIDTH = 130;

export function ListPanel(): React.ReactElement {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const setFocusCode = useUiStore((s) => s.setFocusCode);
  const focusCode = useUiStore((s) => s.focusCode);
  const sectors = useSectorsStore((s) => s.sectors);
  const upsert = useSectorsStore((s) => s.upsert);

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

  const codes: readonly string[] = useMemo(() => {
    if (isAll) return ready.map((r) => r.code);
    if (sector === null) return [];
    return sector.codes;
  }, [isAll, sector, ready]);

  const klineBatch = useKlineBulk(codes, 5);

  const evidenceKeys: readonly string[] = useMemo(() => {
    if (!isDynamic || sector === null) return [];
    const ev = sector.evidence ?? {};
    const seen = new Set<string>();
    for (const code of Object.keys(ev)) {
      const inner = ev[code];
      if (inner !== undefined) for (const k of Object.keys(inner)) seen.add(k);
    }
    return [...seen].sort();
  }, [isDynamic, sector]);

  const baseRows: readonly ListRow[] = useMemo(
    () => buildRows(codes, universeByCode, klineBatch.byCode, sector?.evidence ?? null),
    [codes, universeByCode, klineBatch.byCode, sector?.evidence],
  );

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

  const onTitleSave = (next: string): void => {
    if (sector === null || isAll) return;
    if (next.trim().length === 0 || next === sector.name) return;
    upsert({ ...sector, name: next.trim() });
  };

  const right =
    error !== null && error !== undefined ? (
      <Text color="up">// {(error as Error).message}</Text>
    ) : isLoading ? (
      <Text>loading…</Text>
    ) : (
      <Text>
        {focusCode === null ? '— no selection' : `▎ ${focusCode}`} · {sortedRows.length} rows
        {klineBatch.isLoading ? ` · stats ${String(klineBatch.readyCount)}/${String(codes.length)}` : ''}
      </Text>
    );

  return (
    <Pane
      feat={Feat.List}
      titleSlot={
        <EditableTitle
          value={sector?.name ?? 'list'}
          editable={sector !== null && !isAll}
          onSave={onTitleSave}
        />
      }
      right={right}
    >
      <Flex direction="column" h="100%" minH={0}>
        {!isDynamic && (
          <FilterHeader
            filter={filter}
            setFilter={setFilter}
            total={baseRows.length}
            hits={filteredRows.length}
          />
        )}
        {isDynamic && sector !== null && <DynamicHeader sector={sector} />}
        <ScrollGrid
          columns={columns}
          rows={sortedRows}
          sort={sort}
          setSort={setSort}
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

function buildRows(
  codes: readonly string[],
  meta: ReadonlyMap<string, StockMetaDto>,
  klineByCode: ReadonlyMap<string, readonly KlineBar[]>,
  evidenceMap: Readonly<Record<string, Readonly<Record<string, unknown>>>> | null,
): readonly ListRow[] {
  const rows: ListRow[] = [];
  for (const code of codes) {
    const m = meta.get(code);
    const bars = klineByCode.get(code);
    const stats = bars === undefined ? null : deriveStats(bars);
    const evidence = evidenceMap?.[code] ?? {};
    const flat: Record<string, unknown> = { ...evidence };
    if (stats !== null) {
      flat['price'] = stats.price;
      flat['chgPct'] = stats.chgPct;
      flat['turnoverRate'] = stats.turnoverRate;
      flat['turnover'] = stats.turnover;
      flat['consecUpDays'] = stats.consecUpDays;
    }
    rows.push({
      code,
      name: m?.name ?? code,
      evidence: flat,
      statsReady: stats !== null,
      price: stats?.price ?? 0,
      chgPct: stats?.chgPct ?? null,
      turnoverRate: stats?.turnoverRate ?? null,
      turnover: stats?.turnover ?? null,
      consecUpDays: stats?.consecUpDays ?? 0,
    });
  }
  return rows;
}

interface EditableTitleProps {
  readonly value: string;
  readonly editable: boolean;
  readonly onSave: (next: string) => void;
}

function EditableTitle({ value, editable, onSave }: EditableTitleProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  if (editing) {
    const commit = (): void => {
      onSave(draft);
      setEditing(false);
    };
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e): void => {
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e): void => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        h="20px"
        w="160px"
        bg="panel"
        borderWidth="1px"
        borderColor="accent"
        borderRadius="0"
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.12em"
        px="6px"
        textTransform="uppercase"
      />
    );
  }
  return (
    <Text
      fontFamily="mono"
      fontSize="10px"
      letterSpacing="0.18em"
      textTransform="uppercase"
      fontWeight="600"
      color="ink2"
      whiteSpace="nowrap"
      overflow="hidden"
      textOverflow="ellipsis"
      cursor={editable ? 'text' : 'default'}
      _hover={editable ? { color: 'accent' } : {}}
      onClick={(): void => {
        if (editable) setEditing(true);
      }}
      title={editable ? 'click to rename' : undefined}
    >
      {value}
    </Text>
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
  readonly w: number;
  readonly align: 'left' | 'right';
  readonly sticky?: boolean;
  readonly render: (row: ListRow) => React.ReactNode;
  readonly sortValue: (row: ListRow) => number | string | null;
}

function buildColumns(evidenceKeys: readonly string[]): readonly ColumnDef[] {
  const base: ColumnDef[] = [
    {
      key: 'name',
      label: 'CODE',
      w: STICKY_COL_WIDTH,
      align: 'left',
      sticky: true,
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
      w: 90,
      align: 'right',
      render: (r) => <PriceCell pct={r.chgPct} price={r.statsReady ? r.price : null} />,
      sortValue: (r) => (r.statsReady ? r.price : null),
    },
    {
      key: 'chgPct',
      label: 'CHG%',
      w: 90,
      align: 'right',
      render: (r) => <ChgPctCell value={r.chgPct} />,
      sortValue: (r) => r.chgPct,
    },
    {
      key: 'turnoverRate',
      label: '换手',
      w: 90,
      align: 'right',
      render: (r) => <PctCell value={r.turnoverRate} />,
      sortValue: (r) => r.turnoverRate,
    },
    {
      key: 'turnover',
      label: '成交额',
      w: 110,
      align: 'right',
      render: (r) => <CnyCell value={r.turnover} />,
      sortValue: (r) => r.turnover,
    },
    {
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
    },
  ];
  for (const k of evidenceKeys) {
    base.push({
      key: `ev:${k}`,
      label: k.toUpperCase(),
      w: 130,
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

interface ScrollGridProps {
  readonly columns: readonly ColumnDef[];
  readonly rows: readonly ListRow[];
  readonly sort: SortState | null;
  readonly setSort: (s: SortState | null) => void;
  readonly focusedCode: string | null;
  readonly onRowClick: (row: ListRow) => void;
  readonly emptyHint: string;
}

function ScrollGrid({
  columns,
  rows,
  sort,
  setSort,
  focusedCode,
  onRowClick,
  emptyHint,
}: ScrollGridProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const totalWidth = columns.reduce((acc, c) => acc + c.w, 0);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
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

  return (
    <Box ref={scrollRef} flex="1" overflow="auto" position="relative">
      <Box w={`${String(totalWidth)}px`} minW="100%">
        <ColumnHeader columns={columns} sort={sort} setSort={setSort} />
        <Box
          position="relative"
          h={`${String(rowVirtualizer.getTotalSize())}px`}
          w={`${String(totalWidth)}px`}
        >
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            if (row === undefined) return null;
            return (
              <RowItem
                key={vi.key}
                row={row}
                columns={columns}
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
    </Box>
  );
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
      display="flex"
      bg="panel3"
      borderBottomWidth="1px"
      borderColor="line"
      flexShrink={0}
      position="sticky"
      top={0}
      zIndex={3}
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
            w={`${String(c.w)}px`}
            px="10px"
            py="6px"
            textAlign={c.align}
            color={active ? 'accent' : 'ink3'}
            fontFamily="mono"
            fontSize="10px"
            letterSpacing="0.16em"
            textTransform="uppercase"
            fontWeight="700"
            bg="panel3"
            cursor="pointer"
            _hover={{ color: 'accent' }}
            position={c.sticky === true ? 'sticky' : 'static'}
            left={c.sticky === true ? 0 : undefined}
            zIndex={c.sticky === true ? 4 : 3}
            borderColor="line"
            flexShrink={0}
          >
            {c.label}
            {arrow}
          </Box>
        );
      })}
    </Box>
  );
}

interface RowItemProps {
  readonly row: ListRow;
  readonly columns: readonly ColumnDef[];
  readonly top: number;
  readonly h: number;
  readonly focused: boolean;
  readonly onClick: () => void;
}

function RowItem({ row, columns, top, h, focused, onClick }: RowItemProps): React.ReactElement {
  return (
    <Box
      position="absolute"
      top={0}
      left={0}
      transform={`translateY(${String(top)}px)`}
      h={`${String(h)}px`}
      display="flex"
      alignItems="center"
      borderBottomWidth="1px"
      borderColor="line2"
      borderLeftWidth={focused ? '2px' : 0}
      borderLeftColor="accent"
      bg={focused ? 'accentBg' : 'panel'}
      cursor="pointer"
      _hover={focused ? {} : { bg: 'hover' }}
      onClick={onClick}
    >
      {columns.map((c) => (
        <Box
          key={c.key}
          w={`${String(c.w)}px`}
          h={`${String(h)}px`}
          px="10px"
          py="4px"
          textAlign={c.align}
          overflow="hidden"
          display="flex"
          alignItems="center"
          justifyContent={c.align === 'right' ? 'flex-end' : 'flex-start'}
          position={c.sticky === true ? 'sticky' : 'static'}
          left={c.sticky === true ? 0 : undefined}
          bg={c.sticky === true ? (focused ? 'accentBg' : 'panel') : 'transparent'}
          zIndex={c.sticky === true ? 1 : 0}
          borderBottomWidth={c.sticky === true ? '1px' : 0}
          borderColor="line2"
          flexShrink={0}
        >
          {c.render(row)}
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
  price: number | null;
}): React.ReactElement {
  if (price === null) {
    return (
      <Text fontFamily="mono" fontSize="11px" color="ink3">
        —
      </Text>
    );
  }
  const color = pct === null ? 'ink3' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'ink3';
  return (
    <Text fontFamily="mono" fontSize="11px" color={color} fontWeight="600">
      {price.toFixed(2)}
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
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  if (va === null && vb === null) return 0;
  if (va === null) return -1;
  if (vb === null) return 1;
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb));
}

function sortValue(r: ListRow, key: string): number | string | null {
  if (key === 'name') return r.name;
  if (key === 'code') return r.code;
  if (key === 'price') return r.statsReady ? r.price : null;
  if (key === 'chgPct') return r.chgPct;
  if (key === 'turnoverRate') return r.turnoverRate;
  if (key === 'turnover') return r.turnover;
  if (key === 'consecUp') return r.consecUpDays;
  if (key.startsWith('ev:')) {
    const k = key.slice(3);
    return evidenceSortKey(r.evidence[k]);
  }
  return null;
}

function evidenceSortKey(v: unknown): number | string | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return null;
  return String(v);
}

function formatEvidence(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v);
}
