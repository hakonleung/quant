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

import { Flex, Text } from '@chakra-ui/react';
import type { StockMetaDto } from '@quant/shared';
import { useEffect, useMemo, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import {
  BUILTIN_KEYS,
  buildRows,
  compareRows,
  flattenEvidence,
  type ListRow,
} from '../../lib/fp/eq-list-fp.js';
import { useBlacklistSet } from '../../lib/hooks/use-blacklist.js';
import { useKlineBulk, useStockSnapshots } from '../../lib/hooks/use-eqty-data.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useSectorsStore } from '../../lib/stores/sectors.store.js';
import { useSettingsStore } from '../../lib/stores/settings.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from '../feat-view/feat-view.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';

import { appliedNeedsSnapshot, buildColumns } from './list-columns.js';
import {
  DynamicHeader,
  EditableTitle,
  FilterHeader,
  UserSectorHeader,
} from './list-headers.js';
import type { ColumnDef, SortState } from './list-types.js';
import { ScrollGrid } from './scroll-grid.js';


// `ListRow`, `BUILTIN_KEYS`, `buildRows`, `flattenEvidence`,
// `formatRelativeTime`, sort comparators and evidence-cell helpers all
// live in `lib/fp/eq-list-fp.ts` — pure modules with their own unit
// tests. This file holds only the React layer (state, hooks, JSX).


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


