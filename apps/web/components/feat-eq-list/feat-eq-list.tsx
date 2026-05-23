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

import { Box, Flex, Text } from '@chakra-ui/react';
import type { ColumnFilter, StockListKind, StockMetaDto } from '@quant/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import {
  BUILTIN_KEYS,
  compareValues,
  evaluateColumnFilter,
  flattenEvidence,
  listRowFromStockListRow,
  type ListRow,
} from '../../lib/fp/eq-list-fp.js';
import { useBlacklistSet } from '../../lib/hooks/use-blacklist.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useStockListRows } from '../../lib/hooks/use-stock-list-rows.js';
import { useSectorsStore } from '../../lib/stores/sectors.store.js';
import { useSettingsStore } from '../../lib/stores/settings.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from '../feat-view/feat-view.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';

import { BasicList } from './basic-list.js';
import { buildColumns } from './list-columns.js';
import { AllSectorHeader, DynamicHeader, EditableTitle, UserSectorHeader } from './list-headers.js';
import type { ColumnDef, SortState } from './list-types.js';
import { ScrollGrid } from './scroll-grid.js';

// `ListRow`, `BUILTIN_KEYS`, `buildRows`, `flattenEvidence`,
// `formatRelativeTime`, sort comparators and evidence-cell helpers all
// live in `lib/fp/eq-list-fp.ts` — pure modules with their own unit
// tests. This file holds only the React layer (state, hooks, JSX).

interface FeatEqListProps {
  /** Hosted inside MKT as the lower body — render content only, no
   *  FeatView chrome (the parent owns the pane frame). */
  readonly bare?: boolean;
  /** When hosted in MKT, the parent owns the title slot — this callback
   *  surfaces `{total, matched}` so MKT can show the count next to the
   *  sector name. `total` is post-blacklist universe size for All, or
   *  the sector's member count; `matched` is after column-filter pass. */
  readonly onCountsChange?: (counts: { readonly total: number; readonly matched: number }) => void;
}

export function FeatEqList({ bare, onCountsChange }: FeatEqListProps = {}): React.ReactElement {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const sectors = useSectorsStore((s) => s.sectors);
  const activeSector = sectors.find((x) => x.id === activeSectorId) ?? null;
  // HK / US user sectors render a basic list (code + name only) since
  // there is no kline / snapshot pipeline behind those markets in V1.
  if (
    activeSector !== null &&
    activeSector.kind === 'user' &&
    (activeSector.market === 'hk' || activeSector.market === 'us')
  ) {
    return <BasicList sector={activeSector} market={activeSector.market} bare={bare ?? false} />;
  }
  return (
    <FeatEqListInner
      bare={bare ?? false}
      {...(onCountsChange !== undefined ? { onCountsChange } : {})}
    />
  );
}

function FeatEqListInner({ bare, onCountsChange }: FeatEqListProps = {}): React.ReactElement {
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
  // Single BE-assembled fetch — replaces the legacy meta + kline +
  // snapshot stitch. For the synthetic All sector we send the
  // blacklist-filtered code list explicitly: sending `[]` would tell
  // the BE to expand to the full universe, which re-includes the
  // blacklisted codes the FE just filtered out. Real sectors send
  // their own member list verbatim.
  const listKind: StockListKind = isDynamic ? 'dynamic-sector' : 'user-sector';
  const stockListQuery = useStockListRows({
    kind: listKind,
    codes,
    enabled: codes.length > 0,
  });
  const stockListRows = stockListQuery.data?.rows ?? [];

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
    () => stockListRows.map((r) => listRowFromStockListRow(r, sector?.evidence?.[r.code])),
    [stockListRows, sector?.evidence],
  );

  // Drop rows whose rank_metric is null when the dynamic sector ranks by
  // a metric — the screen pipeline will eventually filter these server-
  // side, but legacy cached results may still carry them.
  const hasRankMetric = isDynamic && sector?.rank != null;
  const filteredRows: readonly ListRow[] = useMemo(() => {
    if (!hasRankMetric) return baseRows;
    return baseRows.filter((r) => {
      const v = r['rank_metric'];
      return v !== null && v !== undefined;
    });
  }, [baseRows, hasRankMetric]);

  const appliedColumns = useSettingsStore((s) => s.appliedColumns);
  const columnFilters = useSettingsStore((s) => s.columnFilters);
  const columnFilterScope = useSettingsStore((s) => s.columnFilterScope);
  // When the user pinned filters to the synthetic "All" sector only,
  // suppress the per-column predicate pass on every other view so user /
  // dynamic sectors render untouched.
  const filtersActive = columnFilterScope === 'all-sectors' || isAll;
  // Columns read every value (including derived/return fields) straight
  // from the row — list-columns no longer needs a parallel snapshot map.
  const columns: readonly ColumnDef[] = useMemo(
    () => buildColumns(appliedColumns, evidenceKeys),
    [appliedColumns, evidenceKeys],
  );

  // Per-column predicates from the USR column manager — applied after
  // the search filter and before the sort. We resolve each filter
  // against the column's `sortValue` extractor so the predicate sees
  // the same numeric the user sorts by. `null` from the evaluator means
  // "no opinion" (列值为空跳过) and the row passes that predicate.
  const filterEntries: readonly { col: ColumnDef; filter: ColumnFilter }[] = useMemo(() => {
    if (!filtersActive) return [];
    const out: { col: ColumnDef; filter: ColumnFilter }[] = [];
    for (const col of columns) {
      const f = columnFilters[col.key as keyof typeof columnFilters];
      if (f === undefined) continue;
      out.push({ col, filter: f });
    }
    return out;
  }, [columns, columnFilters, filtersActive]);
  const predicateRows: readonly ListRow[] = useMemo(() => {
    if (filterEntries.length === 0) return filteredRows;
    return filteredRows.filter((row) => {
      for (const { col, filter } of filterEntries) {
        const res = evaluateColumnFilter(col.sortValue(row), filter);
        // For dynamic sectors, treat "no value" as "drop" so DSL filters
        // exclude stocks with missing metrics (e.g. fresh listings with
        // no 20D% history).
        if (res === false) return false;
        if (res === null && isDynamic) return false;
      }
      return true;
    });
  }, [filteredRows, filterEntries, isDynamic]);

  useEffect(() => {
    onCountsChange?.({ total: baseRows.length, matched: predicateRows.length });
  }, [baseRows.length, predicateRows.length, onCountsChange]);

  // Default sort: dynamic sectors with a rank metric sort by rank_metric
  // (using the rank's order); otherwise mirror the BE's response sort
  // (currently `wcmi desc` — see shared `DEFAULT_SORT_BY_KIND`). Falling
  // back to `chgPct desc` keeps the panel useful before the first BE
  // response lands. `null` is reserved for the "use sector-defined
  // order" mode (kept accessible by clicking the active sort header
  // twice).
  const beSort = stockListQuery.data?.sort;
  const defaultSort: SortState = useMemo(() => {
    if (isDynamic && sector !== null && sector.rank !== undefined && sector.rank !== null) {
      return { key: 'ev:rank_metric', dir: sector.rank.order === 'asc' ? 'asc' : 'desc' };
    }
    if (beSort !== undefined) return { key: beSort.key, dir: beSort.dir };
    return { key: 'chgPct', dir: 'desc' };
  }, [isDynamic, sector, beSort]);
  const [sort, setSort] = useState<SortState | null>(defaultSort);
  const lastSectorIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = sector?.id ?? null;
    if (lastSectorIdRef.current === id) return;
    lastSectorIdRef.current = id;
    setSort(defaultSort);
  }, [sector?.id, defaultSort]);
  // Adopt the BE sort once it arrives on initial mount — `useState`
  // initialised before the first query landed, so the panel would
  // otherwise stay on the `chgPct desc` fallback even though the BE
  // told us `wcmi desc`. Only runs the first time; later user clicks
  // (or sector switches) keep their own setSort flow.
  const adoptedBeSortRef = useRef(false);
  useEffect(() => {
    if (adoptedBeSortRef.current) return;
    if (beSort === undefined) return;
    adoptedBeSortRef.current = true;
    setSort({ key: beSort.key, dir: beSort.dir });
  }, [beSort]);
  const columnsByKey = useMemo(() => {
    const m = new Map<string, ColumnDef>();
    for (const c of columns) m.set(c.key, c);
    return m;
  }, [columns]);
  const sortedRows: readonly ListRow[] = useMemo(() => {
    if (sort === null) return predicateRows;
    const col = columnsByKey.get(sort.key);
    if (col === undefined) return predicateRows;
    const arr = [...predicateRows];
    arr.sort((a, b) => compareValues(col.sortValue(a), col.sortValue(b)));
    if (sort.dir === 'desc') arr.reverse();
    return arr;
  }, [predicateRows, sort, columnsByKey]);

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
      : isLoading || stockListQuery.isLoading
        ? 'amber'
        : 'green';
  return (
    <FeatView
      feat={Feat.Mkt}
      bare={bare ?? false}
      status={listTone}
      statusBlink={isLoading || stockListQuery.isLoading}
      titleSlot={
        <Flex align="baseline" gap="8px" minW={0}>
          <EditableTitle
            value={sector?.name ?? 'list'}
            editable={sector !== null && !isAll}
            onSave={onTitleSave}
          />
          {/* Live row count after every filter pass — column predicates
              from the USR pane shrink this without changing baseRows,
              so users need a running tally to see the filter biting. */}
          <Box
            as="span"
            fontFamily="mono"
            fontSize="10px"
            color="ink3"
            letterSpacing="0.12em"
            whiteSpace="nowrap"
          >
            {predicateRows.length === baseRows.length
              ? String(baseRows.length)
              : `${String(predicateRows.length)}/${String(baseRows.length)}`}
          </Box>
        </Flex>
      }
    >
      <Flex direction="column" h="100%" minH={0}>
        {isAll && <AllSectorHeader onPick={setFocusCode} />}
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
