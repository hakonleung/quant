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

import { Box, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';

import {
  buildInitialState,
  fromCondition,
  INITIAL_STATE,
  NEW_GROUP_SENTINEL,
  secondsToMinuteString,
  type AddFormState,
  type PickedStock,
  type WatchAddInitial,
} from '../../lib/fp/watch-add-fp.js';

import { useWatchGroups } from './use-watch-groups.js';
import { postBatch, postGroup } from './watch-add-api.js';
import { GroupRow, isNewGroupNameInvalid, PickRow, SubmitRow } from './watch-add-rows.js';
import { ConditionsList } from './watch-condition-row.js';

// Re-export the public surface that callers (feat-watch-live, the
// override flow) import from this module — keeps the public API
// stable while the implementation lives under lib/fp.
export type { PickedStock, WatchAddInitial };

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

  const newNameValid = state.mode !== 'new' || !isNewGroupNameInvalid(state.newGroupName);
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
