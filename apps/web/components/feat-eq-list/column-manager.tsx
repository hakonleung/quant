'use client';

/**
 * EQ.LIST column manager (`docs/modules/07-frontend.md` §4.1.1).
 *
 * Two side-by-side sections — `APPLIED` (ordered, removable, reorderable
 * via ↑ ↓ buttons) and `AVAILABLE` (the catalog ∖ applied, click + to
 * append). The CODE column is treated as immutable — it's hard-prepended
 * by the renderer and hidden here. Evidence columns are sector-driven
 * and do not appear here.
 *
 * Edits commit immediately to {@link useSettingsStore.setAppliedColumns}
 * — the row was previously gated behind a modal Save button but the
 * inline panel host (SYS.CFG) keeps the surface lightweight.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { ColumnFilter, ColumnFilterOp } from '@quant/shared';
import { useState } from 'react';

import {
  COLUMN_CATALOG,
  getColumnSpec,
  type ColumnKey,
  type ColumnSpec,
} from '../../lib/eqty/columns.catalog.js';
import { useSettingsStore } from '../../lib/stores/settings.store.js';
import { MonoButton } from '../ui/mono-button.js';

const IMMUTABLE: ReadonlySet<ColumnKey> = new Set(['name']);

/**
 * Numeric (filterable) columns. The CODE column is string-typed and the
 * snapshot-driven returns/PE columns operate on numeric `sortValue`s, so
 * the predicate UI is only meaningful for these.
 */
const FILTERABLE: ReadonlySet<ColumnKey> = new Set([
  'price',
  'chgPct',
  'turnoverRate',
  'turnover',
  'consecUp',
  'ret5d',
  'ret10d',
  'ret20d',
  'ret90d',
  'ret250d',
  'wcmi',
  'wcmiRhythm',
  'wcmiMaSupport',
  'wcmiUpWave',
  'wcmiYangDom',
  'wcmiShadowClean',
  'wcmiStageGain',
  'wcmiCrashAvoid',
  'wcmiRecentStrength',
  'mktCap',
  'floatMktCap',
  'peTtm',
  'peDynamic',
  'pb',
  'peg',
  'grossMargin',
  'ddeMainInflow3d',
  'ddeMainInflow5d',
  'ddeMainInflow10d',
  'ddeMainInflow20d',
  'ddeMainInflowRatio3d',
  'ddeMainInflowRatio5d',
  'ddeMainInflowRatio10d',
  'ddeMainInflowRatio20d',
]);

const OPS: readonly ColumnFilterOp[] = ['>', '>=', '<', '<=', '=', '!='];

export function ColumnManager(): React.ReactElement {
  const persisted = useSettingsStore((s) => s.appliedColumns);
  const setAppliedColumns = useSettingsStore((s) => s.setAppliedColumns);
  const columnFilters = useSettingsStore((s) => s.columnFilters);
  const setColumnFilter = useSettingsStore((s) => s.setColumnFilter);

  const removable = persisted.filter((k) => !IMMUTABLE.has(k));
  const available: readonly ColumnSpec[] = COLUMN_CATALOG.filter(
    (s) => !persisted.includes(s.key) && !IMMUTABLE.has(s.key),
  );

  const commitOrder = (removableNext: readonly ColumnKey[]): readonly ColumnKey[] => {
    // Re-thread the immutable keys in their canonical position (CODE
    // first); keeps `applied` deterministic regardless of mutation order.
    return ['name' as ColumnKey, ...removableNext];
  };

  const move = (idx: number, delta: number): void => {
    const next = [...removable];
    const j = idx + delta;
    if (j < 0 || j >= next.length) return;
    const tmp = next[idx]!;
    next[idx] = next[j]!;
    next[j] = tmp;
    setAppliedColumns(commitOrder(next));
  };

  const remove = (key: ColumnKey): void => {
    setAppliedColumns(commitOrder(removable.filter((k) => k !== key)));
  };

  const add = (key: ColumnKey): void => {
    setAppliedColumns(commitOrder([...removable, key]));
  };

  return (
    <Flex h="100%" minH={0} minW={0}>
      <PaneSection label="// APPLIED">
        {removable.length === 0 ? (
          <Empty>no extra columns selected</Empty>
        ) : (
          removable.map((key, idx) => {
            const spec = getColumnSpec(key);
            return (
              <Flex
                key={key}
                direction="column"
                gap="4px"
                px="10px"
                py="6px"
                borderBottomWidth="1px"
                borderColor="term.line"
                fontFamily="mono"
                fontSize="xs"
                _hover={{ bg: 'term.bgElev' }}
              >
                <Flex align="center" gap="6px">
                  <Text flex="1" color="term.ink" whiteSpace="nowrap">
                    {spec.label}
                  </Text>
                  <Text color="term.ink3" fontSize="xs" whiteSpace="nowrap">
                    {spec.group}
                  </Text>
                  <MonoButton
                    icon="up"
                    label="move up"
                    onClick={(): void => {
                      move(idx, -1);
                    }}
                    disabled={idx === 0}
                  />
                  <MonoButton
                    icon="down"
                    label="move down"
                    onClick={(): void => {
                      move(idx, 1);
                    }}
                    disabled={idx === removable.length - 1}
                  />
                  <MonoButton
                    icon="delete"
                    label="remove"
                    onClick={(): void => {
                      remove(key);
                    }}
                  />
                </Flex>
                {FILTERABLE.has(key) && (
                  <FilterRow
                    filter={columnFilters[key] ?? null}
                    onChange={(next): void => {
                      setColumnFilter(key, next);
                    }}
                  />
                )}
              </Flex>
            );
          })
        )}
      </PaneSection>
      <PaneSection label="// AVAILABLE">
        {available.length === 0 ? (
          <Empty>every catalog column is already applied</Empty>
        ) : (
          available.map((spec) => (
            <Flex
              key={spec.key}
              align="center"
              gap="6px"
              px="10px"
              py="6px"
              borderBottomWidth="1px"
              borderColor="term.line"
              fontFamily="mono"
              fontSize="xs"
              _hover={{ bg: 'term.bgElev' }}
            >
              <Text flex="1" color="term.ink" whiteSpace="nowrap">
                {spec.label}
              </Text>
              <Text color="term.ink3" fontSize="xs" whiteSpace="nowrap">
                {spec.group}
              </Text>
              <MonoButton
                icon="add"
                label="add to applied"
                onClick={(): void => {
                  add(spec.key);
                }}
              />
            </Flex>
          ))
        )}
      </PaneSection>
    </Flex>
  );
}

interface FilterRowProps {
  readonly filter: ColumnFilter | null;
  readonly onChange: (next: ColumnFilter | null) => void;
}

const SELECT_STYLE: React.CSSProperties = {
  fontFamily: 'var(--chakra-fonts-mono, ui-monospace, monospace)',
  fontSize: 'var(--chakra-font-sizes-xs, 11px)',
  background: 'var(--chakra-colors-term-panel, transparent)',
  color: 'var(--chakra-colors-term-ink, inherit)',
  border: '1px solid var(--chakra-colors-term-line, currentColor)',
  padding: '1px 4px',
};

const INPUT_STYLE: React.CSSProperties = {
  ...SELECT_STYLE,
  flex: 1,
  minWidth: '60px',
};

/**
 * Per-column predicate editor. Edits live in local string state so a
 * partially-typed value (e.g. `-` mid-typing) doesn't immediately rewrite
 * the persisted filter as `0` and surprise the row pipeline. We commit
 * on blur / Enter and accept removal via the trash button.
 */
function FilterRow({ filter, onChange }: FilterRowProps): React.ReactElement {
  const [draft, setDraft] = useState<string>(filter === null ? '' : String(filter.value));
  const op: ColumnFilterOp = filter?.op ?? '>';

  const commit = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      if (filter !== null) onChange(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    if (filter !== null && filter.op === op && filter.value === n) return;
    onChange({ op, value: n });
  };

  const onOpChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const nextOp = e.target.value as ColumnFilterOp;
    if (filter !== null) {
      onChange({ op: nextOp, value: filter.value });
      return;
    }
    const trimmed = draft.trim();
    if (trimmed === '') return;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    onChange({ op: nextOp, value: n });
  };

  return (
    <Flex align="center" gap="6px" pl="2px">
      <Text color="term.ink3" fontSize="xs" letterSpacing="0.16em" w="38px">
        FILTER
      </Text>
      <select value={op} onChange={onOpChange} style={SELECT_STYLE}>
        {OPS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        placeholder="∅"
        onChange={(e: React.ChangeEvent<HTMLInputElement>): void => {
          setDraft(e.target.value);
        }}
        onBlur={(): void => {
          commit(draft);
        }}
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>): void => {
          if (e.key === 'Enter') {
            commit(draft);
            (e.target as HTMLInputElement).blur();
          }
        }}
        style={INPUT_STYLE}
      />
      {filter !== null && (
        <MonoButton
          icon="delete"
          label="clear filter"
          onClick={(): void => {
            setDraft('');
            onChange(null);
          }}
        />
      )}
    </Flex>
  );
}

function PaneSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box
      flex="0 0 220px"
      overflowY="auto"
      overflowX="hidden"
      borderRightWidth="1px"
      borderColor="term.line"
      minW="220px"
      h="100%"
    >
      <Text
        px="10px"
        py="6px"
        fontFamily="mono"
        fontSize="xs"
        letterSpacing="0.18em"
        color="term.ink3"
        fontWeight="700"
        bg="term.panel"
        position="sticky"
        top={0}
      >
        {label}
      </Text>
      {children}
    </Box>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text
      px="10px"
      py="10px"
      fontFamily="mono"
      fontSize="xs"
      color="term.ink3"
      letterSpacing="0.12em"
    >
      // {children}
    </Text>
  );
}
