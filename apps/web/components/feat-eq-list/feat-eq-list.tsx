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
import type { StockMetaDto, StockSnapshotDto } from '@quant/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  appliedNeedsSnapshot,
  getColumnSpec,
  type ColumnKey,
} from '../../lib/eqty/columns.catalog.js';
import { Feat } from '../../lib/eqty/feat.js';
import {
  BUILTIN_KEYS,
  buildRows,
  compareRows,
  evidenceColumnKind,
  evidenceSortKey,
  flattenEvidence,
  formatEvidence,
  formatRelativeTime,
  toNumberOrNull,
  type EvidenceColumnKind,
  type ListRow,
} from '../../lib/fp/eq-list-fp.js';
import { useBlacklistSet } from '../../lib/hooks/use-blacklist.js';
import { useKlineBulk, useStockSnapshots } from '../../lib/hooks/use-eqty-data.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { refreshSector } from '../../lib/api/sectors.js';
import { useLayoutStore } from '../../lib/stores/layout.store.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { useSettingsStore } from '../../lib/stores/settings.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { FeatScrDsl } from '../feat-scr-dsl/feat-scr-dsl.js';
import { FeatScrNl } from '../feat-scr-nl/feat-scr-nl.js';
import { FeatView } from '../feat-view/feat-view.js';
import { MonoButton } from '../ui/mono-button.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';

const DELETE_COL_W = 32;

// `ListRow`, `BUILTIN_KEYS`, `buildRows`, `flattenEvidence`,
// `formatRelativeTime`, sort comparators and evidence-cell helpers all
// live in `lib/fp/eq-list-fp.ts` — pure modules with their own unit
// tests. This file holds only the React layer (state, hooks, JSX).

interface SortState {
  readonly key: string;
  readonly dir: 'asc' | 'desc';
}

const STICKY_COL_WIDTH = 110;
const ROW_H = 26;

export function FeatEqList(): React.ReactElement {
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
  const isUserSector = sector !== null && sector.kind === 'user';

  // Codes used for both row construction and the bulk kline fetch.
  // For the synthetic "All" sector we render every meta-listed stock
  // **minus the cron-managed blacklist** but do NOT enumerate them on
  // the wire — the bulk endpoint expands an empty `codes` to the full
  // universe server-side (and applies the server-side cap), saving us
  // from a multi-kilobyte query string. User / dynamic sectors keep
  // their own member list verbatim — the blacklist is only applied to
  // the synthetic All view.
  const blacklistSet = useBlacklistSet();
  const codes: readonly string[] = useMemo(() => {
    if (isAll) return ready.map((r) => r.code).filter((c) => !blacklistSet.has(c));
    if (sector === null) return [];
    return sector.codes;
  }, [isAll, sector, ready, blacklistSet]);
  const bulkCodes: readonly string[] = isAll ? [] : codes;
  // For "All" we deliberately send [] and rely on the server to expand
  // to the full universe — force-enable the query in that mode so the
  // hook's default-disabled-on-empty rule doesn't gate it off.
  const klineBatch = useKlineBulk(bulkCodes, 5, {
    enabled: isAll || bulkCodes.length > 0,
  });

  const evidenceKeys: readonly string[] = useMemo(() => {
    if (!isDynamic || sector === null) return [];
    const ev = sector.evidence ?? {};
    const seen = new Set<string>();
    for (const code of Object.keys(ev)) {
      const inner = ev[code];
      if (inner === undefined) continue;
      for (const k of Object.keys(flattenEvidence(inner))) {
        // Built-in stat columns already cover these — skipping avoids
        // duplicate side-by-side columns when the screening evaluator
        // surfaces the same metric we compute from kline.
        if (BUILTIN_KEYS.has(k)) continue;
        seen.add(k);
      }
    }
    return [...seen].sort();
  }, [isDynamic, sector]);

  const baseRows: readonly ListRow[] = useMemo(
    () => buildRows(codes, universeByCode, klineBatch.byCode, sector?.evidence ?? null),
    [codes, universeByCode, klineBatch.byCode, sector?.evidence],
  );

  const [filter, setFilter] = useState('');
  const filteredRows: readonly ListRow[] = useMemo(() => {
    if (isDynamic || isUserSector) return baseRows;
    const q = filter.trim().toLowerCase();
    if (q === '') return baseRows;
    return baseRows.filter((r) => r.code.startsWith(q) || r.name.toLowerCase().includes(q));
  }, [baseRows, filter, isDynamic, isUserSector]);

  // Default sort: descending by chgPct so winners surface first.
  // `null` is reserved for the "use sector-defined order" mode (kept
  // accessible by clicking the active sort header twice to clear it).
  const [sort, setSort] = useState<SortState | null>({ key: 'chgPct', dir: 'desc' });
  const sortedRows: readonly ListRow[] = useMemo(() => {
    if (sort === null) return filteredRows;
    const arr = [...filteredRows];
    arr.sort((a, b) => compareRows(a, b, sort.key));
    if (sort.dir === 'desc') arr.reverse();
    return arr;
  }, [filteredRows, sort]);

  const appliedColumns = useSettingsStore((s) => s.appliedColumns);
  const snapshots = useStockSnapshots(codes, {
    enabled: appliedNeedsSnapshot(appliedColumns),
  });
  const columns: readonly ColumnDef[] = useMemo(
    () => buildColumns(appliedColumns, evidenceKeys, snapshots.byCode),
    [appliedColumns, evidenceKeys, snapshots.byCode],
  );

  // Auto-default focus to the first visible row of the active sector.
  // Fires when (a) nothing is focused yet, or (b) the persisted focus
  // is no longer in the current sector (e.g. after a sector switch or
  // a dynamic re-screen dropped the previous pick). Gated on store
  // hydration so the IndexedDB-restored focusCode wins on cold start.
  const uiHydrated = useUiHydrated();
  useEffect(() => {
    if (!uiHydrated) return;
    if (sortedRows.length === 0) return;
    const stillVisible = focusCode !== null && sortedRows.some((r) => r.code === focusCode);
    if (stillVisible) return;
    setFocusCode(sortedRows[0]!.code);
  }, [uiHydrated, sortedRows, focusCode, setFocusCode]);

  const onTitleSave = (next: string): void => {
    if (sector === null || isAll) return;
    if (next.trim().length === 0 || next === sector.name) return;
    upsert({ ...sector, name: next.trim() });
  };

  const onUserAddCode = (code: string): void => {
    if (sector === null || sector.kind !== 'user') return;
    if (sector.codes.includes(code)) return;
    const nextCodes = [...sector.codes, code];
    upsert({ ...sector, codes: nextCodes, count: nextCodes.length });
  };

  const onUserAddCodes = (codes: readonly string[]): void => {
    if (sector === null || sector.kind !== 'user') return;
    const existing = new Set(sector.codes);
    const nextCodes = [...sector.codes];
    for (const c of codes) {
      if (existing.has(c)) continue;
      existing.add(c);
      nextCodes.push(c);
    }
    if (nextCodes.length === sector.codes.length) return;
    upsert({ ...sector, codes: nextCodes, count: nextCodes.length });
  };

  const { guard: confirmGuard, comp: confirmComp } = useConfirm();
  const onUserRemoveCode = (code: string): void => {
    if (sector === null || sector.kind !== 'user') return;
    if (!sector.codes.includes(code)) return;
    const meta = universeByCode.get(code);
    const display = meta === undefined ? code : `${code} · ${meta.name}`;
    confirmGuard({
      title: 'remove from sector',
      message: (
        <Text fontFamily="mono" fontSize="12px" color="ink2" lineHeight="1.7">
          remove{' '}
          <Text as="span" color="accent">
            {display}
          </Text>{' '}
          from{' '}
          <Text as="span" color="accent">
            {sector.name}
          </Text>
          ?
        </Text>
      ),
      confirmLabel: 'REMOVE',
    })
      .then(() => {
        const nextCodes = sector.codes.filter((c) => c !== code);
        upsert({ ...sector, codes: nextCodes, count: nextCodes.length });
      })
      .catch((e: unknown) => {
        if (e instanceof ConfirmCancelled) return;
        throw e;
      });
  };

  const listTone =
    error !== null && error !== undefined
      ? 'red'
      : isLoading || klineBatch.isLoading || snapshots.isLoading
        ? 'amber'
        : 'green';
  return (
    <FeatView
      feat={Feat.EquityList}
      status={listTone}
      statusBlink={isLoading || klineBatch.isLoading}
      titleSlot={
        <EditableTitle
          value={sector?.name ?? 'list'}
          editable={sector !== null && !isAll}
          onSave={onTitleSave}
        />
      }
    >
      <Flex direction="column" h="100%" minH={0}>
        {isAll && (
          <FilterHeader
            filter={filter}
            setFilter={setFilter}
            total={baseRows.length}
            hits={filteredRows.length}
          />
        )}
        {isUserSector && sector !== null && (
          <UserSectorHeader sector={sector} onAdd={onUserAddCode} onBatchAdd={onUserAddCodes} />
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
          onRowRemove={isUserSector ? onUserRemoveCode : null}
          emptyHint={
            isAll
              ? 'universe empty (run an orchestrator sync)'
              : isDynamic
                ? 'no dynamic hits'
                : 'sector has no members'
          }
        />
      </Flex>
      {confirmComp}
    </FeatView>
  );
}

function useUiHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useUiStore.persist.hasHydrated());
  useEffect(() => {
    if (hydrated) return;
    const unsub = useUiStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    return unsub;
  }, [hydrated]);
  return hydrated;
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

function UserSectorHeader({
  onAdd,
  onBatchAdd,
}: {
  sector: Sector;
  onAdd: (code: string) => void;
  onBatchAdd: (codes: readonly string[]) => void;
}): React.ReactElement {
  return (
    <Box flexShrink={0}>
      <FeatScrNl
        marketFilter="a"
        onPick={(s): void => {
          onAdd(s.code);
        }}
        onBatchPick={(stocks): void => {
          onBatchAdd(stocks.map((s) => s.code));
        }}
      />
    </Box>
  );
}

function DynamicHeader({ sector }: { sector: Sector }): React.ReactElement {
  // FeatScrDsl is wrapped in FeatView; we mirror its persisted mode so
  // the host wrapper collapses to header-height when minimized and
  // expands to a definite 320 px when restored. A definite height when
  // restored is required because FeatView body's flex chain otherwise
  // resolves to 0 px in an indefinite parent — that prevents the
  // body's internal scroll from engaging on long plans.
  const mode = useLayoutStore((s) => s.featViewMode[Feat.ScreenDsl]);
  const isMinimized = mode === 'minimized';
  return (
    <>
      <DynamicRefreshBar sector={sector} />
      <Box
        h={isMinimized ? 'auto' : '320px'}
        display="flex"
        flexDirection="column"
        minH={0}
        flexShrink={0}
      >
        <FeatScrDsl />
      </Box>
    </>
  );
}

function DynamicRefreshBar({ sector }: { sector: Sector }): React.ReactElement {
  const upsert = useSectorsStore((s) => s.upsert);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canRefresh = sector.screenPlan !== undefined;
  const onRefresh = (): void => {
    if (!canRefresh || pending) return;
    setPending(true);
    setError(null);
    refreshSector(sector.id)
      .then((next) => {
        upsert(next);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <Flex
      align="center"
      gap="10px"
      px="14px"
      py="6px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
      flexShrink={0}
    >
      <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.14em">
        {/* eslint-disable-next-line no-restricted-globals -- relative-time
            display ticks on render; pulling a Clock through props for a
            cosmetic "Nm ago" label isn't worth the plumbing. */}
        last screened: {formatRelativeTime(sector.lastScreenedAt, Date.now())}
      </Text>
      <Box flex="1" />
      {error !== null && (
        <Text fontFamily="mono" fontSize="10px" color="down" letterSpacing="0.06em">
          {error}
        </Text>
      )}
      <MonoButton
        icon="refresh"
        label={canRefresh ? (pending ? 'refreshing…' : 'refresh') : 'no plan to re-run'}
        onClick={onRefresh}
        disabled={!canRefresh || pending}
      />
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

function buildColumns(
  applied: readonly ColumnKey[],
  evidenceKeys: readonly string[],
  snapshotByCode: ReadonlyMap<string, StockSnapshotDto>,
): readonly ColumnDef[] {
  const out: ColumnDef[] = [];
  // CODE is always first + sticky regardless of user preference; the
  // dialog hides the toggle for it. We still render it from the catalog
  // entry so styling stays single-sourced.
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
      return derivedColumn('peDynamic', 'PE动态', 90, snapshotByCode, (d) => d.pe_dynamic, 'ratio');
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

interface ScrollGridProps {
  readonly columns: readonly ColumnDef[];
  readonly rows: readonly ListRow[];
  readonly sort: SortState | null;
  readonly setSort: (s: SortState | null) => void;
  readonly focusedCode: string | null;
  readonly onRowClick: (row: ListRow) => void;
  readonly onRowRemove: ((code: string) => void) | null;
  readonly emptyHint: string;
}

function ScrollGrid({
  columns,
  rows,
  sort,
  setSort,
  focusedCode,
  onRowClick,
  onRowRemove,
  emptyHint,
}: ScrollGridProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const removable = onRowRemove !== null;
  const totalWidth = columns.reduce((acc, c) => acc + c.w, 0) + (removable ? DELETE_COL_W : 0);

  // Stable row-level handlers so RowItem's React.memo can bail out for
  // rows whose props didn't actually change (focus moves between two
  // rows, sort flips, column resize). The closures below capture
  // current props through refs so we don't need them in the
  // dependency list.
  const onRowClickRef = useRef(onRowClick);
  const onRowRemoveRef = useRef(onRowRemove);
  onRowClickRef.current = onRowClick;
  onRowRemoveRef.current = onRowRemove;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onSelectByCode = useCallback((code: string): void => {
    const row = rowsRef.current.find((r) => r.code === code);
    if (row !== undefined) {
      onRowClickRef.current(row);
      scrollRef.current?.focus({ preventScroll: true });
    }
  }, []);
  const onRemoveByCode = useCallback((code: string): void => {
    onRowRemoveRef.current?.(code);
  }, []);
  const removeHandler = removable ? onRemoveByCode : null;

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  // Cache the row index for the currently-focused code so the keyboard
  // handler can step ±1 in O(1). `-1` means "no focus yet" — the first
  // arrow press lands on row 0.
  const focusedIndex = useMemo(() => {
    if (focusedCode === null) return -1;
    return rows.findIndex((r) => r.code === focusedCode);
  }, [rows, focusedCode]);

  // ArrowUp/Down step focus through the sorted rows when the grid (or
  // any of its descendants) has keyboard focus. PageUp/Down jump 10
  // rows; Home/End snap to the ends. The handler also auto-scrolls
  // the new focus row into view via the virtualizer.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return;
    const cur = focusedIndex < 0 ? -1 : focusedIndex;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        next = cur < 0 ? 0 : Math.min(rows.length - 1, cur + 1);
        break;
      case 'ArrowUp':
        next = cur < 0 ? 0 : Math.max(0, cur - 1);
        break;
      case 'PageDown':
        next = cur < 0 ? 0 : Math.min(rows.length - 1, cur + 10);
        break;
      case 'PageUp':
        next = cur < 0 ? 0 : Math.max(0, cur - 10);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      default:
        return;
    }
    if (next === null || next === cur) return;
    e.preventDefault();
    const target = rows[next];
    if (target === undefined) return;
    onRowClick(target);
    rowVirtualizer.scrollToIndex(next, { align: 'auto' });
  };

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
    <Box
      ref={scrollRef}
      flex="1"
      overflow="auto"
      position="relative"
      tabIndex={0}
      role="listbox"
      aria-label="股票列表"
      aria-activedescendant={focusedCode !== null ? `eqlist-row-${focusedCode}` : undefined}
      onKeyDown={onKeyDown}
      // Focus ring is muted to match the dense workbench look. The
      // outline is what tells keyboard users the grid is listening for
      // ArrowUp/Down.
      _focus={{ outline: 'none' }}
      _focusVisible={{ boxShadow: '0 0 0 1px var(--chakra-colors-accent) inset' }}
    >
      <Box w={`${String(totalWidth)}px`} minW="100%">
        <ColumnHeader columns={columns} sort={sort} setSort={setSort} removable={removable} />
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
                onSelect={onSelectByCode}
                onRemove={removeHandler}
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
  removable,
}: {
  columns: readonly ColumnDef[];
  sort: SortState | null;
  setSort: (s: SortState | null) => void;
  removable: boolean;
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
      {removable && (
        <Box
          w={`${String(DELETE_COL_W)}px`}
          flexShrink={0}
          position="sticky"
          left={0}
          bg="panel3"
          zIndex={4}
        />
      )}
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
            px="8px"
            py="4px"
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
            left={c.sticky === true ? (removable ? `${String(DELETE_COL_W)}px` : 0) : undefined}
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
  /** Receives `row.code`; the parent looks up the full row from a ref. */
  readonly onSelect: (code: string) => void;
  /** `null` when the active sector isn't user-managed. */
  readonly onRemove: ((code: string) => void) | null;
}

const RowItem = memo(function RowItem({
  row,
  columns,
  top,
  h,
  focused,
  onSelect,
  onRemove,
}: RowItemProps): React.ReactElement {
  const hasRemove = onRemove !== null;
  const onClick = (): void => {
    onSelect(row.code);
  };
  return (
    <Box
      // `id` + ScrollGrid's `aria-activedescendant` give screen readers
      // a stable handle on the keyboard-focused row without moving DOM
      // focus off the grid container.
      id={`eqlist-row-${row.code}`}
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
      role="option"
      aria-selected={focused}
    >
      {hasRemove && (
        <Box
          position="sticky"
          left={0}
          h={`${String(h)}px`}
          w={`${String(DELETE_COL_W)}px`}
          display="grid"
          placeItems="center"
          bg={focused ? 'accentBg' : 'panel'}
          zIndex={2}
          flexShrink={0}
        >
          <MonoButton
            icon="delete"
            label={`remove ${row.code}`}
            onClick={(e: React.MouseEvent<HTMLButtonElement>): void => {
              e.stopPropagation();
              onRemove(row.code);
            }}
          />
        </Box>
      )}
      {columns.map((c) => (
        <Box
          key={c.key}
          w={`${String(c.w)}px`}
          h={`${String(h)}px`}
          px="8px"
          py="2px"
          textAlign={c.align}
          overflow="hidden"
          display="flex"
          alignItems="center"
          justifyContent={c.align === 'right' ? 'flex-end' : 'flex-start'}
          position={c.sticky === true ? 'sticky' : 'static'}
          left={c.sticky === true ? (hasRemove ? `${String(DELETE_COL_W)}px` : 0) : undefined}
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
});

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

