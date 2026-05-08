'use client';

/**
 * Inline add-form for the Watch pane.
 *
 * Persistent at the top of the pane: user picks N stocks via the M-0
 * search (chips), shares one condition list across them, names the
 * group they belong to, then submits — one task per stock.
 *
 * Group flow (`docs/modules/06-watch.md`):
 *
 *   - "+ new group" → user types a fresh name; the conds/intervals
 *     they edit on the form become this group's stored conds/intervals.
 *     Submit POSTs `/api/watch/groups` first, then the tasks.
 *   - "<existing group>" → conds/intervals become read-only (the
 *     group already owns them, editing here would silently mutate
 *     other tasks). Submit just POSTs the tasks.
 *
 * The optional `initial` prop is used by the "override" flow: a group
 * of existing tasks has been deleted and their stocks/conds are
 * pushed back into this form. We open in "new group" mode with the
 * conds prefilled and an empty name field — the user picks a fresh
 * name (or reuses the old one now that it's free).
 *
 * v0 only POSTs sequentially via the BFF — no dedicated batch endpoint.
 */

import { Box, Flex, Input, Text } from '@chakra-ui/react';
import {
  WATCH_GROUP_NAME_PATTERN,
  type WatchBaseline,
  type WatchGroup,
} from '@quant/shared';
import { useEffect, useMemo, useState } from 'react';

import type { UniverseStock } from '../../lib/hooks/use-stock-universe.js';
import { useStockUniverse } from '../../lib/hooks/use-stock-universe.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import {
  BASELINE_ITEMS,
  buildInitialState,
  describeCondition,
  fromCondition,
  INITIAL_CONDITION,
  INITIAL_STATE,
  KIND_ITEMS,
  NEW_GROUP_SENTINEL,
  OP_ITEMS,
  secondsToMinuteString,
  type AddFormState,
  type ConditionDraft,
  type Kind,
  type Op,
  type PickedStock,
  type WatchAddInitial,
} from '../../lib/fp/watch-add-fp.js';
import { FeatScrNl } from '../feat-scr-nl/feat-scr-nl.js';
import { MonoButton } from '../ui/mono-button.js';

import { TermSelect } from './term-select.js';
import { useWatchGroups } from './use-watch-groups.js';
import { postBatch, postGroup } from './watch-add-api.js';

// Re-export the public surface that callers (feat-watch-live, the
// override flow) import from this module — keeps the public API
// stable while the implementation lives under lib/fp.
export type { PickedStock, WatchAddInitial };

const INPUT_STYLE = {
  bg: 'term.bg' as const,
  borderColor: 'term.line' as const,
  color: 'term.ink' as const,
  fontFamily: 'mono' as const,
  fontSize: '12px',
  h: '24px',
  px: '6px',
};

interface AddFormProps {
  readonly initial?: WatchAddInitial;
  /** Called after a successful submit so the parent can refresh group state. */
  readonly onSubmitted?: () => void;
}

export function WatchAddForm({ initial, onSubmitted }: AddFormProps): React.ReactElement {
  const [state, setState] = useState<AddFormState>(() => buildInitialState(initial));
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<readonly string[]>([]);
  const { groups, refresh: refreshGroups } = useWatchGroups();

  // When the user picks an existing group, mirror its conds/intervals
  // into the local state so the read-only display shows the right
  // values (and the override-style "edit then post" path can't drift).
  useEffect(() => {
    if (state.mode !== 'existing') return;
    const g = groups.find((x) => x.name === state.groupSelection);
    if (g === undefined) return;
    setState((prev) => ({
      ...prev,
      conditions: g.conditions.map(fromCondition),
      intervalMin: secondsToMinuteString(g.intervalSec),
      pushIntervalMin: secondsToMinuteString(g.pushIntervalSec),
    }));
  }, [state.mode, state.groupSelection, groups]);

  const groupReadOnly = state.mode === 'existing';

  const newNameValid =
    state.mode !== 'new' ||
    (state.newGroupName.length > 0 && WATCH_GROUP_NAME_PATTERN.test(state.newGroupName));
  const newNameDuplicate =
    state.mode === 'new' && groups.some((g) => g.name === state.newGroupName);
  const groupReady =
    state.mode === 'new'
      ? newNameValid && !newNameDuplicate
      : groups.some((g) => g.name === state.groupSelection);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setErrs([]);
    try {
      let groupName: string;
      if (state.mode === 'new') {
        const created = await postGroup(state, state.newGroupName);
        groupName = created.name;
        refreshGroups();
      } else {
        groupName = state.groupSelection;
      }
      const failures = await postBatch(state.picked, groupName);
      if (failures.length === 0) {
        // Reset picks but keep the user's group selection so a follow-up
        // batch under the same group is one click away.
        setState((prev) => ({
          ...INITIAL_STATE,
          mode: prev.mode,
          groupSelection: prev.mode === 'existing' ? prev.groupSelection : NEW_GROUP_SENTINEL,
          newGroupName: '',
        }));
        onSubmitted?.();
      } else {
        setErrs(failures);
      }
    } catch (e) {
      setErrs([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = state.picked.length > 0 && state.conditions.length > 0 && groupReady;

  return (
    <Box
      mb="10px"
      p="8px"
      border="1px solid"
      borderColor="term.line"
      bg="term.bgElev"
      color="term.ink2"
    >
      <GroupRow
        state={state}
        setState={setState}
        groups={groups}
        duplicate={newNameDuplicate}
        invalid={!newNameValid}
      />
      <PickRow state={state} setState={setState} />
      <ConditionsList state={state} setState={setState} readOnly={groupReadOnly} />
      <SubmitRow
        state={state}
        setState={setState}
        busy={busy}
        canSubmit={canSubmit}
        readOnly={groupReadOnly}
        onSubmit={(): void => {
          void submit();
        }}
      />
      {errs.length > 0 ? (
        <Box mt="6px">
          {errs.map((e, i) => (
            <Text key={`err-${String(i)}`} color="term.red" fontSize="11px">
              {e}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

interface RowProps {
  readonly state: AddFormState;
  readonly setState: React.Dispatch<React.SetStateAction<AddFormState>>;
}

interface GroupRowProps extends RowProps {
  readonly groups: readonly WatchGroup[];
  readonly duplicate: boolean;
  readonly invalid: boolean;
}

function GroupRow({
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
      <Text fontSize="11px" color="term.ink3" letterSpacing="0.14em">
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
            <Text fontSize="11px" color="term.red">
              1–32 chars · letters/digits/space/_/-
            </Text>
          ) : null}
          {duplicate ? (
            <Text fontSize="11px" color="term.red">
              name already exists
            </Text>
          ) : null}
        </>
      ) : (
        <Text fontSize="11px" color="term.ink3">
          conds · intervals owned by this group (read-only)
        </Text>
      )}
    </Flex>
  );
}

interface SectorImportRowProps {
  readonly onBatchPick: (stocks: readonly UniverseStock[]) => void;
}

function SectorImportRow({ onBatchPick }: SectorImportRowProps): React.ReactElement | null {
  const sectors = useSectorsStore((s) => s.sectors);
  const { data: universe } = useStockUniverse('a');
  const codeToStock = useMemo(() => {
    const m = new Map<string, UniverseStock>();
    for (const s of universe) if (s.market === 'a') m.set(s.code, s);
    return m;
  }, [universe]);
  const onImport = (sector: Sector): void => {
    const stocks: UniverseStock[] = [];
    for (const c of sector.codes) {
      const hit = codeToStock.get(c);
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
  }, [sectors, codeToStock]);
  if (sectors.length === 0) return null;
  return (
    <Flex gap="4px" wrap="wrap" align="center" mb="6px">
      <Text fontSize="11px" color="term.ink3" letterSpacing="0.14em" mr="2px">
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

function PickRow({ state, setState }: RowProps): React.ReactElement {
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
  return (
    <Box>
      <SectorImportRow onBatchPick={onBatchPick} />
      <FeatScrNl onPick={onPick} onBatchPick={onBatchPick} />
      {state.picked.length === 0 ? (
        <Text mt="4px" fontSize="11px" color="term.ink3">
          search and pick one or more stocks · same condition applies to all
        </Text>
      ) : (
        <Flex mt="4px" gap="4px" wrap="wrap">
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
              fontSize="11px"
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

function ConditionsList({
  state,
  setState,
  readOnly,
}: RowProps & { readonly readOnly: boolean }): React.ReactElement {
  const onAdd = (): void => {
    setState((prev) => ({ ...prev, conditions: [...prev.conditions, INITIAL_CONDITION] }));
  };
  const onRemove = (idx: number): void => {
    setState((prev) => {
      if (prev.conditions.length <= 1) return prev;
      return { ...prev, conditions: prev.conditions.filter((_, i) => i !== idx) };
    });
  };
  const onChange = (idx: number, next: ConditionDraft): void => {
    setState((prev) => ({
      ...prev,
      conditions: prev.conditions.map((c, i) => (i === idx ? next : c)),
    }));
  };
  return (
    <Box mt="6px">
      <Flex justify="space-between" align="center" mb="4px">
        <Text fontSize="11px" color="term.ink3" letterSpacing="0.14em">
          CONDITIONS · ANY-OF
        </Text>
        {readOnly ? null : (
          <MonoButton icon="add" label="add condition" onClick={onAdd}>
            add
          </MonoButton>
        )}
      </Flex>
      <Flex direction="column" gap="4px">
        {state.conditions.map((c, i) => (
          <ConditionRow
            key={`cond-${String(i)}`}
            cond={c}
            canRemove={!readOnly && state.conditions.length > 1}
            readOnly={readOnly}
            onChange={(next): void => {
              onChange(i, next);
            }}
            onRemove={(): void => {
              onRemove(i);
            }}
          />
        ))}
      </Flex>
    </Box>
  );
}

interface ConditionRowProps {
  readonly cond: ConditionDraft;
  readonly canRemove: boolean;
  readonly readOnly: boolean;
  readonly onChange: (next: ConditionDraft) => void;
  readonly onRemove: () => void;
}

function ConditionRow({
  cond,
  canRemove,
  readOnly,
  onChange,
  onRemove,
}: ConditionRowProps): React.ReactElement {
  if (readOnly) {
    return (
      <Flex gap="6px" wrap="wrap" align="center" color="term.ink3" fontSize="11px">
        <Text fontFamily="mono">{describeCondition(cond)}</Text>
      </Flex>
    );
  }
  return (
    <Flex gap="6px" wrap="wrap" align="center">
      <TermSelect<Kind>
        value={cond.kind}
        items={KIND_ITEMS}
        width="76px"
        onChange={(v): void => {
          onChange({ ...cond, kind: v });
        }}
      />
      {cond.kind === 'pct' ? (
        <>
          <TermSelect<WatchBaseline>
            value={cond.baseline}
            items={BASELINE_ITEMS}
            width="130px"
            onChange={(v): void => {
              onChange({ ...cond, baseline: v });
            }}
          />
          {cond.baseline === 'trend' ? (
            <Flex align="center" gap="2px">
              <Input
                {...INPUT_STYLE}
                w="60px"
                placeholder="window"
                value={cond.windowSec}
                onChange={(e): void => {
                  onChange({ ...cond, windowSec: e.target.value });
                }}
              />
              <Text color="term.ink3" fontSize="11px">
                s
              </Text>
            </Flex>
          ) : null}
          <TermSelect<Op>
            value={cond.op}
            items={OP_ITEMS}
            width="60px"
            onChange={(v): void => {
              onChange({ ...cond, op: v });
            }}
          />
          <Input
            {...INPUT_STYLE}
            w="60px"
            placeholder="±%"
            value={cond.thresholdPct}
            onChange={(e): void => {
              const v = e.target.value;
              onChange({ ...cond, thresholdPct: v });
            }}
          />
        </>
      ) : (
        <>
          <TermSelect<Op>
            value={cond.op}
            items={OP_ITEMS}
            width="60px"
            onChange={(v): void => {
              onChange({ ...cond, op: v });
            }}
          />
          <Input
            {...INPUT_STYLE}
            w="80px"
            placeholder="price"
            value={cond.thresholdPrice}
            onChange={(e): void => {
              const v = e.target.value;
              onChange({ ...cond, thresholdPrice: v });
            }}
          />
        </>
      )}
      <Box ml="auto">
        <MonoButton
          icon="delete"
          label="remove condition"
          disabled={!canRemove}
          onClick={onRemove}
        />
      </Box>
    </Flex>
  );
}

interface SubmitRowProps extends RowProps {
  readonly busy: boolean;
  readonly canSubmit: boolean;
  readonly readOnly: boolean;
  readonly onSubmit: () => void;
}

function SubmitRow({
  state,
  setState,
  busy,
  canSubmit,
  readOnly,
  onSubmit,
}: SubmitRowProps): React.ReactElement {
  return (
    <Flex gap="6px" mt="6px" align="center">
      <Text color="term.ink3" fontSize="11px">
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
      <Text color="term.ink3" fontSize="11px">
        m
      </Text>
      <Text color="term.ink3" fontSize="11px">
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
      <Text color="term.ink3" fontSize="11px">
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
