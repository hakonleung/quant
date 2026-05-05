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
import type { KlineBar, StockMetaDto, StockSnapshotDto } from '@quant/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  appliedNeedsSnapshot,
  getColumnSpec,
  type ColumnKey,
} from '../../lib/eqty/columns.catalog.js';
import { Feat } from '../../lib/eqty/feat.js';
import { deriveStats, type StockStats } from '../../lib/fp/stock-stats.js';
import { useKlineBulk, useStockSnapshots } from '../../lib/hooks/use-eqty-data.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useBlacklistStore } from '../../lib/stores/blacklist.store.js';
import { useLayoutStore } from '../../lib/stores/layout.store.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { useSettingsStore } from '../../lib/stores/settings.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { FeatScrDsl } from "../feat-scr-dsl/feat-scr-dsl.js";
import { FeatScrNl } from "../feat-scr-nl/feat-scr-nl.js";
import { FeatView } from "../feat-view/feat-view.js";
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';

/**
 * Row payload — flat record so dynamic sectors literally see
 * ``{...stock, ...metrics, ...evidence}`` and arbitrary evidence keys
 * resolve via ``row[key]`` without indirection.
 */
interface ListRow extends StockStats, Record<string, unknown> {
  readonly code: string;
  readonly name: string;
  readonly statsReady: boolean;
}

/**
 * Built-in column keys covered by the standard stat columns; evidence
 * keys colliding with these are folded into the standard column rather
 * than producing a duplicate.
 */
const BUILTIN_KEYS: ReadonlySet<string> = new Set([
  'name',
  'code',
  'price',
  'chgPct',
  'turnoverRate',
  'turnover',
  'consecUp',
  'consecUpDays',
  'statsReady',
]);

interface SortState {
  readonly key: string;
  readonly dir: 'asc' | 'desc';
}

const STICKY_COL_WIDTH = 130;

export function FeatEqList(): React.ReactElement {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const setFocusCode = useUiStore((s) => s.setFocusCode);
  const focusCode = useUiStore((s) => s.focusCode);
  const sectors = useSectorsStore((s) => s.sectors);
  const upsert = useSectorsStore((s) => s.upsert);
  const blacklist = useBlacklistStore((s) => s.entries);
  const blacklistSet = useMemo(() => new Set(blacklist.map((b) => b.code)), [blacklist]);

  const { data, isLoading, error } = useStockList();
  const universe = data ?? [];
  const ready = useMemo(
    () => universe.filter((s) => s.industries !== '' && !blacklistSet.has(s.code)),
    [universe, blacklistSet],
  );
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
  // but do NOT enumerate them on the wire — the bulk endpoint expands
  // an empty `codes` to the full universe server-side (and applies the
  // server-side cap), saving us from a multi-kilobyte query string.
  const codes: readonly string[] = useMemo(() => {
    if (isAll) return ready.map((r) => r.code);
    if (sector === null) return [];
    // Sector definitions are persisted, blacklist isn't part of the
    // sector — strip blacklisted members at render time so the user's
    // bans apply across every sector view (user + dynamic).
    return sector.codes.filter((c) => !blacklistSet.has(c));
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

  const [sort, setSort] = useState<SortState | null>(null);
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
    const rawEvidence = evidenceMap?.[code] ?? {};
    const evidence = flattenEvidence(rawEvidence);
    // {...stock, ...evidence, ...metrics} — kline-derived metrics win
    // last so they override anything the screening evaluator emitted
    // under the same key (the built-in column already shows the kline
    // value; the evidence column has been filtered out upstream).
    const row: Record<string, unknown> = {
      ...m,
      ...evidence,
      code,
      name: m?.name ?? code,
      statsReady: stats !== null,
      price: stats?.price ?? 0,
      chgPct: stats?.chgPct ?? null,
      turnoverRate: stats?.turnoverRate ?? null,
      turnover: stats?.turnover ?? null,
      consecUpDays: stats?.consecUpDays ?? 0,
    };
    rows.push(row as ListRow);
  }
  return rows;
}

/**
 * Flatten one stock's evaluator evidence and coerce numeric strings.
 *
 * The screening service emits a nested shape:
 *
 *     { metrics: { amount: "5.3e9", pct_chg_qfq: "0.034", ... },
 *       window:  ["2025-04-03", "2026-04-30"] }
 *
 * The list-panel renders one column per leaf key, so we lift every
 * dict-valued field's children into the parent and turn decimal-as-
 * string values into numbers for sort + format. Non-dict values
 * (arrays, scalars) pass through unchanged.
 */
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

function flattenEvidence(
  raw: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isPlainObject(v)) {
      for (const [inK, inV] of Object.entries(v)) {
        out[inK] = coerceNumeric(inV);
      }
    } else {
      out[k] = coerceNumeric(v);
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === null || proto === Object.prototype;
}

function coerceNumeric(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  // Decimal-as-string round-tripped from Python; treat as number when
  // the entire string parses cleanly. Leaves dates / arbitrary text
  // alone.
  if (!/^-?\d+(?:\.\d+)?$/.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
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

function DynamicHeader(_props: { sector: Sector }): React.ReactElement {
  // FeatScrDsl is wrapped in FeatView; we mirror its persisted mode so
  // the host wrapper collapses to header-height when minimized and
  // expands to a definite 320 px when restored. A definite height when
  // restored is required because FeatView body's flex chain otherwise
  // resolves to 0 px in an indefinite parent — that prevents the
  // body's internal scroll from engaging on long plans.
  const mode = useLayoutStore((s) => s.featViewMode[Feat.ScreenDsl]);
  const isMinimized = mode === 'minimized';
  return (
    <Box
      h={isMinimized ? 'auto' : '320px'}
      display="flex"
      flexDirection="column"
      minH={0}
      flexShrink={0}
    >
      <FeatScrDsl />
    </Box>
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

type EvidenceColumnKind = 'cny' | 'chgPct' | 'raw';

/**
 * Pick a display formatter for a dynamic-sector evidence key based on
 * the screening evaluator's column-name conventions:
 *
 *   - `amount`               → CNY notional (万 / 亿)
 *   - `*pct*`                → change-pct (signed, two-decimal %)
 *   - `*period_return*`      → change-pct (period total return, fraction)
 *   - `*rate*`               → change-pct (turnover_rate etc., fraction)
 *   - everything else        → raw formatter (numbers / strings / arrays)
 *
 * Match is on lowercased substring so casing variations (`pct_chg_qfq`,
 * `PERIOD_RETURN_240D`, `TurnoverRate`) all hit the right branch.
 */
function evidenceColumnKind(key: string): EvidenceColumnKind {
  const k = key.toLowerCase();
  if (k === 'amount') return 'cny';
  if (k.includes('pct')) return 'chgPct';
  if (k.includes('period_return')) return 'chgPct';
  if (k.includes('rate')) return 'chgPct';
  return 'raw';
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

function toNumberOrNull(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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
                onRemove={
                  onRowRemove === null
                    ? null
                    : (): void => {
                        onRowRemove(row.code);
                      }
                }
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
  readonly onRemove: (() => void) | null;
}

function RowItem({
  row,
  columns,
  top,
  h,
  focused,
  onClick,
  onRemove,
}: RowItemProps): React.ReactElement {
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
      role="group"
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
      {onRemove !== null && (
        <Box
          as="button"
          aria-label={`remove ${row.code}`}
          title="remove from sector"
          onClick={(e: React.MouseEvent): void => {
            e.stopPropagation();
            onRemove();
          }}
          position="sticky"
          right={0}
          ml="auto"
          h={`${String(h)}px`}
          w="32px"
          display="grid"
          placeItems="center"
          bg={focused ? 'accentBg' : 'panel'}
          color="ink3"
          fontFamily="mono"
          fontSize="14px"
          flexShrink={0}
          _hover={{ color: 'down' }}
        >
          ×
        </Box>
      )}
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
    return evidenceSortKey(r[k]);
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
