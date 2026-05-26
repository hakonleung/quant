'use client';

/**
 * Picker / group / submit rows of the WATCH add-form. Split out of
 * `watch-add-form.tsx` so the orchestrator stays under the 400-line
 * ceiling.
 *
 * Every component below receives the same `state + setState` slice
 * the orchestrator owns (typed via `RowProps`); the shared INPUT_STYLE
 * lives in `watch-form-style.ts` so each row can import it without
 * pulling in the orchestrator.
 */

import { Box, Flex, Input, Text } from '@chakra-ui/react';
import { WATCH_GROUP_NAME_PATTERN, type WatchGroup } from '@quant/shared';
import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';

import {
  NEW_GROUP_SENTINEL,
  type AddFormState,
  type PickedStock,
} from '../../lib/fp/watch-add-fp.js';
import type { UniverseStock } from '../../lib/hooks/use-stock-universe.js';
import { useStockUniverse } from '../../lib/hooks/use-stock-universe.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { FeatScrNl } from '../feat-scr-nl/feat-scr-nl.js';
import { MonoButton } from '../ui/mono-button.js';

import { TermSelect } from './term-select.js';
import { INPUT_STYLE } from './watch-form-style.js';

// `RowProps` is the shared shape every row consumes. Re-exported so
// the orchestrator can pass the same `state + setState` slice across
// all rows.
export interface RowProps {
  readonly state: AddFormState;
  readonly setState: Dispatch<SetStateAction<AddFormState>>;
}

interface GroupRowProps extends RowProps {
  readonly groups: readonly WatchGroup[];
  readonly duplicate: boolean;
  readonly invalid: boolean;
}

export function GroupRow({
  state,
  setState,
  groups,
  duplicate,
  invalid,
}: GroupRowProps): React.ReactElement {
  const items = useMemo(
    () => [
      { label: '+ new group', value: NEW_GROUP_SENTINEL },
      ...groups.map((g) => ({ label: g.name, value: g.name })),
    ],
    [groups],
  );
  const onChangeSelection = (v: string): void => {
    if (v === NEW_GROUP_SENTINEL) {
      setState((prev) => ({ ...prev, groupSelection: NEW_GROUP_SENTINEL, mode: 'new' }));
      return;
    }
    setState((prev) => ({ ...prev, groupSelection: v, mode: 'existing' }));
  };
  return (
    <Flex gap="6px" align="center" mb="6px" wrap="wrap">
      <Text fontSize="xs" color="term.ink3" letterSpacing="0.14em">
        GROUP
      </Text>
      <TermSelect<string>
        value={state.groupSelection}
        items={items}
        width="170px"
        onChange={onChangeSelection}
      />
      {state.mode === 'new' ? (
        <>
          <Input
            {...INPUT_STYLE}
            w="180px"
            placeholder="new group name"
            value={state.newGroupName}
            onChange={(e): void => {
              const v = e.target.value;
              setState((prev) => ({ ...prev, newGroupName: v }));
            }}
          />
          {state.newGroupName.length > 0 && invalid ? (
            <Text fontSize="xs" color="up">
              1–32 chars · letters/digits/space/_/-
            </Text>
          ) : null}
          {duplicate ? (
            <Text fontSize="xs" color="up">
              name already exists
            </Text>
          ) : null}
        </>
      ) : (
        <Text fontSize="xs" color="term.ink3">
          conds · intervals owned by this group (read-only)
        </Text>
      )}
    </Flex>
  );
}

// Validate the typed-in new-group name against the canonical pattern
// from @quant/shared. Re-exported so the orchestrator can compute the
// invalid/duplicate flags it passes back to GroupRow.
export function isNewGroupNameInvalid(name: string): boolean {
  return name.length === 0 || !WATCH_GROUP_NAME_PATTERN.test(name);
}

interface SectorImportRowProps {
  readonly onBatchPick: (stocks: readonly UniverseStock[]) => void;
}

export function SectorImportRow({ onBatchPick }: SectorImportRowProps): React.ReactElement | null {
  const sectors = useSectorsStore((s) => s.sectors);
  // Pull all three markets so HK / US user sectors resolve too. Lookup
  // key is `${market}:${code}` since codes can collide across markets
  // (e.g. A-share 600519 vs an HK 600519 listing).
  const { data: universe } = useStockUniverse();
  const lookup = useMemo(() => {
    const m = new Map<string, UniverseStock>();
    for (const s of universe) m.set(`${s.market}:${s.code}`, s);
    return m;
  }, [universe]);
  const onImport = (sector: Sector): void => {
    const sectorMarket = sector.market ?? 'a';
    const stocks: UniverseStock[] = [];
    for (const c of sector.codes) {
      const hit = lookup.get(`${sectorMarket}:${c}`);
      if (hit !== undefined) stocks.push(hit);
    }
    if (stocks.length > 0) onBatchPick(stocks);
  };
  // Alt+1…9 (or Alt+0 for the 10th) imports the i-th sector. Skips
  // when focus is in a text input so the shortcut doesn't fight typing.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const target = e.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const digit = e.key === '0' ? 9 : Number.parseInt(e.key, 10) - 1;
      if (Number.isNaN(digit) || digit < 0 || digit >= sectors.length) return;
      e.preventDefault();
      const sec = sectors[digit];
      if (sec !== undefined) onImport(sec);
    };
    window.addEventListener('keydown', handler);
    return (): void => {
      window.removeEventListener('keydown', handler);
    };
  }, [sectors, lookup]);
  if (sectors.length === 0) return null;
  return (
    <Flex gap="4px" wrap="wrap" align="center" mb="6px">
      <Text fontSize="xs" color="term.ink3" letterSpacing="0.14em" mr="2px">
        SECTOR
      </Text>
      {sectors.map((sec, idx) => (
        <MonoButton
          key={sec.id}
          icon="add"
          label={`import ${String(sec.codes.length)} stocks from ${sec.name} (alt+${String(idx + 1)})`}
          onClick={(): void => {
            onImport(sec);
          }}
        >
          {sec.name} ({sec.codes.length})
        </MonoButton>
      ))}
    </Flex>
  );
}

export function PickRow({ state, setState }: RowProps): React.ReactElement {
  const onPick = (s: UniverseStock): void => {
    setState((prev) => {
      if (prev.picked.some((p) => p.market === s.market && p.code === s.code)) return prev;
      const next: PickedStock = { market: s.market, code: s.code, name: s.name };
      return { ...prev, picked: [...prev.picked, next] };
    });
  };
  const onBatchPick = (stocks: readonly UniverseStock[]): void => {
    setState((prev) => {
      const seen = new Set(prev.picked.map((p) => `${p.market}:${p.code}`));
      const next: PickedStock[] = [...prev.picked];
      for (const s of stocks) {
        const key = `${s.market}:${s.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ market: s.market, code: s.code, name: s.name });
      }
      return { ...prev, picked: next };
    });
  };
  const onRemove = (idx: number): void => {
    setState((prev) => ({ ...prev, picked: prev.picked.filter((_, i) => i !== idx) }));
  };
  const onClear = (): void => {
    setState((prev) => ({ ...prev, picked: [] }));
  };
  return (
    <Box>
      <SectorImportRow onBatchPick={onBatchPick} />
      <FeatScrNl onPick={onPick} onBatchPick={onBatchPick} />
      {state.picked.length === 0 ? (
        <Text mt="4px" fontSize="xs" color="term.ink3">
          search and pick one or more stocks · same condition applies to all
        </Text>
      ) : (
        <Flex mt="4px" gap="4px" wrap="wrap" align="center">
          <MonoButton
            icon="delete"
            label={`clear ${String(state.picked.length)} picked stocks`}
            onClick={onClear}
          >
            clear ({state.picked.length})
          </MonoButton>
          {state.picked.map((p, i) => (
            <Flex
              key={`${p.market}:${p.code}`}
              align="center"
              gap="4px"
              px="6px"
              py="2px"
              border="1px solid"
              borderColor="term.green"
              color="term.green"
              fontFamily="mono"
              fontSize="xs"
            >
              <Text>
                [{p.market}] {p.code} · {p.name}
              </Text>
              <MonoButton
                icon="delete"
                label={`remove ${p.code}`}
                onClick={(): void => {
                  onRemove(i);
                }}
              />
            </Flex>
          ))}
        </Flex>
      )}
    </Box>
  );
}

interface SubmitRowProps extends RowProps {
  readonly busy: boolean;
  readonly canSubmit: boolean;
  readonly readOnly: boolean;
  readonly onSubmit: () => void;
}

export function SubmitRow({
  state,
  setState,
  busy,
  canSubmit,
  readOnly,
  onSubmit,
}: SubmitRowProps): React.ReactElement {
  return (
    <Flex gap="6px" mt="6px" align="center">
      <Text color="term.ink3" fontSize="xs">
        interval
      </Text>
      <Input
        {...INPUT_STYLE}
        w="60px"
        value={state.intervalMin}
        readOnly={readOnly}
        onChange={(e): void => {
          const v = e.target.value;
          setState((s) => ({ ...s, intervalMin: v }));
        }}
      />
      <Text color="term.ink3" fontSize="xs">
        m
      </Text>
      <Text color="term.ink3" fontSize="xs">
        push≥
      </Text>
      <Input
        {...INPUT_STYLE}
        w="60px"
        value={state.pushIntervalMin}
        readOnly={readOnly}
        onChange={(e): void => {
          const v = e.target.value;
          setState((s) => ({ ...s, pushIntervalMin: v }));
        }}
      />
      <Text color="term.ink3" fontSize="xs">
        m
      </Text>
      <MonoButton
        icon="add"
        label={busy ? '…' : `add ${String(state.picked.length)}`}
        disabled={busy || !canSubmit}
        onClick={onSubmit}
        ml="auto"
      >
        {busy ? '…' : `add ${String(state.picked.length)}`}
      </MonoButton>
    </Flex>
  );
}
