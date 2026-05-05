'use client';

/**
 * Watch (W-0) pane (`docs/modules/W-0-watch.md` §11).
 *
 * Subscribes to `/api/watch/stream` (SSE, 1 Hz) for live task state.
 * Inline `+ add` toggles `<WatchAddForm/>` for the create flow; per-row
 * × deletes via the BFF and lets the next SSE tick refresh the list.
 *
 * Body scrolls internally so a long task list never inflates the host
 * column. The header `☑` toggle drops the row list into a multi-select
 * mode (checkboxes + bulk DELETE), keeping single-row deletes available
 * by default.
 */

import { Box, Button, Checkbox, Flex, Text } from '@chakra-ui/react';
import { WatchTaskSchema, type WatchCondition, type WatchTask } from '@quant/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';

import { Feat } from '../../lib/eqty/feat.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';
import { FeatView } from '../feat-view/feat-view.js';
import {
  FeatViewAction,
  FeatViewHeaderRight,
  FeatViewStatus,
} from '../feat-view/feat-view-header.js';
import { WatchAddForm } from './watch-add-form.js';

const TaskListSchema = z.array(WatchTaskSchema);

type StreamState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'open'; readonly tasks: readonly WatchTask[] }
  | { readonly kind: 'error'; readonly message: string };

function useWatchStream(): StreamState {
  const [state, setState] = useState<StreamState>({ kind: 'connecting' });
  const stateRef = useRef<StreamState>(state);
  stateRef.current = state;

  useEffect(() => {
    const es = new EventSource('/api/watch/stream');
    es.onmessage = (ev: MessageEvent<string>): void => {
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch (err) {
        setState({ kind: 'error', message: `bad json: ${String(err)}` });
        return;
      }
      const parsed = TaskListSchema.safeParse(raw);
      if (!parsed.success) {
        setState({ kind: 'error', message: parsed.error.message });
        return;
      }
      setState({ kind: 'open', tasks: parsed.data });
    };
    es.onerror = (): void => {
      if (stateRef.current.kind !== 'open') {
        setState({ kind: 'error', message: 'stream disconnected' });
      }
    };
    return (): void => {
      es.close();
    };
  }, []);

  return state;
}

const taskKey = (t: Pick<WatchTask, 'market' | 'code'>): string => `${t.market}:${t.code}`;

export function FeatWatchLive(): React.ReactElement {
  const state = useWatchStream();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const tasks = state.kind === 'open' ? state.tasks : [];
  const { guard, comp: confirmComp } = useConfirm();

  // Drop selections that no longer exist (deleted upstream).
  const liveKeys = useMemo(() => new Set(tasks.map(taskKey)), [tasks]);
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set<string>();
      for (const k of prev) if (liveKeys.has(k)) next.add(k);
      return next.size === prev.size ? prev : next;
    });
  }, [liveKeys]);

  const onBulkDelete = async (): Promise<void> => {
    const targets = tasks.filter((t) => selected.has(taskKey(t)));
    if (targets.length === 0) return;
    try {
      await guard({
        title: 'delete watch tasks',
        message: (
          <Text fontFamily="mono" fontSize="12px" color="term.ink2" lineHeight="1.7">
            delete{' '}
            <Text as="span" color="term.red">
              {targets.length}
            </Text>{' '}
            watch tasks? This cannot be undone.
          </Text>
        ),
        confirmLabel: 'DELETE',
      });
    } catch (e) {
      if (e instanceof ConfirmCancelled) return;
      throw e;
    }
    setBulkBusy(true);
    try {
      await Promise.all(targets.map((t) => deleteTask(t)));
      setSelected(new Set());
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <FeatView
      feat={Feat.WatchLive}
      right={
        <FeatViewHeaderRight>
          <FeatViewStatus
            tone={state.kind === 'open' ? 'green' : state.kind === 'error' ? 'red' : 'idle'}
          />
          <FeatViewAction
            title={adding ? 'cancel' : 'add watch'}
            tone={adding ? 'danger' : 'accent'}
            onClick={(): void => {
              setAdding((v) => !v);
            }}
          >
            {adding ? '×' : '+'}
          </FeatViewAction>
        </FeatViewHeaderRight>
      }
    >
      <PanelBody
        state={state}
        tasks={tasks}
        adding={adding}
        onCloseAdd={(): void => {
          setAdding(false);
        }}
        selected={selected}
        bulkBusy={bulkBusy}
        onToggle={(key): void => {
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
        }}
        onSelectAll={(): void => {
          setSelected(new Set(tasks.map(taskKey)));
        }}
        onClearSelection={(): void => {
          setSelected(new Set());
        }}
        onBulkDelete={(): void => {
          void onBulkDelete();
        }}
      />
      {confirmComp}
    </FeatView>
  );
}

interface BodyProps {
  readonly state: StreamState;
  readonly tasks: readonly WatchTask[];
  readonly adding: boolean;
  readonly onCloseAdd: () => void;
  readonly selected: ReadonlySet<string>;
  readonly bulkBusy: boolean;
  readonly onToggle: (key: string) => void;
  readonly onSelectAll: () => void;
  readonly onClearSelection: () => void;
  readonly onBulkDelete: () => void;
}

function PanelBody(props: BodyProps): React.ReactElement {
  const { adding, onCloseAdd, tasks, selected } = props;
  return (
    <Flex
      direction="column"
      flex="1"
      minH={0}
      color="term.ink2"
      fontFamily="mono"
      fontSize="12px"
      lineHeight="1.7"
    >
      {adding ? (
        <Box px="14px" pt="10px" flexShrink={0}>
          <WatchAddForm onClose={onCloseAdd} />
        </Box>
      ) : null}
      {tasks.length > 0 ? (
        <SelectToolbar
          totalCount={tasks.length}
          selectedCount={selected.size}
          bulkBusy={props.bulkBusy}
          onSelectAll={props.onSelectAll}
          onClearSelection={props.onClearSelection}
          onBulkDelete={props.onBulkDelete}
        />
      ) : null}
      <Box px="14px" py="8px">
        <BodyStatus
          state={props.state}
          tasks={tasks}
          selected={selected}
          onToggle={props.onToggle}
        />
      </Box>
    </Flex>
  );
}

interface ToolbarProps {
  readonly totalCount: number;
  readonly selectedCount: number;
  readonly bulkBusy: boolean;
  readonly onSelectAll: () => void;
  readonly onClearSelection: () => void;
  readonly onBulkDelete: () => void;
}

function SelectToolbar({
  totalCount,
  selectedCount,
  bulkBusy,
  onSelectAll,
  onClearSelection,
  onBulkDelete,
}: ToolbarProps): React.ReactElement {
  const allSelected = selectedCount === totalCount && totalCount > 0;
  return (
    <Flex
      align="center"
      gap="8px"
      px="14px"
      py="6px"
      borderTopWidth="1px"
      borderBottomWidth="1px"
      borderColor="term.line"
      bg="term.panel"
      flexShrink={0}
    >
      <Text color="term.ink3" fontSize="10px" letterSpacing="0.16em">
        {selectedCount}/{totalCount} selected
      </Text>
      <Box flex="1" />
      <Button
        size="xs"
        h="22px"
        px="8px"
        borderRadius="0"
        borderWidth="1px"
        borderColor="term.line2"
        bg="transparent"
        color="term.ink2"
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.14em"
        onClick={allSelected ? onClearSelection : onSelectAll}
      >
        {allSelected ? 'CLEAR' : 'SELECT ALL'}
      </Button>
      <Button
        size="xs"
        h="22px"
        px="10px"
        borderRadius="0"
        borderWidth="1px"
        borderColor="term.red"
        bg="transparent"
        color="term.red"
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.14em"
        fontWeight="700"
        loading={bulkBusy}
        disabled={selectedCount === 0}
        onClick={onBulkDelete}
        _disabled={{ opacity: 0.4, cursor: 'not-allowed' }}
      >
        DELETE
      </Button>
    </Flex>
  );
}

interface BodyStatusProps {
  readonly state: StreamState;
  readonly tasks: readonly WatchTask[];
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
}

function BodyStatus({
  state,
  tasks,
  selected,
  onToggle,
}: BodyStatusProps): React.ReactElement {
  if (state.kind === 'connecting') return <Text>connecting…</Text>;
  if (state.kind === 'error') {
    return <Text color="term.red">stream error: {state.message}</Text>;
  }
  if (tasks.length === 0) {
    return <Text color="term.ink3">no tasks. click + add.</Text>;
  }
  return (
    <Flex direction="column" gap="0px">
      {tasks.map((t) => (
        <Row
          key={taskKey(t)}
          task={t}
          checked={selected.has(taskKey(t))}
          onToggle={(): void => {
            onToggle(taskKey(t));
          }}
        />
      ))}
    </Flex>
  );
}

async function deleteTask(task: WatchTask): Promise<string | null> {
  const res = await fetch(`/api/watch/${task.market}/${encodeURIComponent(task.code)}`, {
    method: 'DELETE',
  });
  if (res.ok || res.status === 204) return null;
  return `delete ${String(res.status)}`;
}

interface RowProps {
  readonly task: WatchTask;
  readonly checked: boolean;
  readonly onToggle: () => void;
}

function Row({ task, checked, onToggle }: RowProps): React.ReactElement {
  return (
    <Flex
      align="center"
      gap="6px"
      px="4px"
      py="2px"
      borderBottomWidth="1px"
      borderColor="term.line2"
      cursor="pointer"
      bg={checked ? 'term.panel' : 'transparent'}
      transition="background 120ms ease, color 120ms ease"
      _hover={{ bg: 'term.panel' }}
      onClick={onToggle}
    >
      <Checkbox.Root
        checked={checked}
        size="sm"
        colorPalette="green"
        flexShrink={0}
        onClick={(e): void => {
          e.stopPropagation();
          onToggle();
        }}
      >
        <Checkbox.HiddenInput />
        <Checkbox.Control />
      </Checkbox.Root>
      <RowSummary task={task} />
    </Flex>
  );
}

function RowSummary({ task }: { readonly task: WatchTask }): React.ReactElement {
  return (
    <Flex flex="1" minW={0} align="baseline" gap="6px" lineHeight="1.3">
      <Text fontSize="11px" color="term.ink3" letterSpacing="0.04em" flexShrink={0}>
        [{task.market}]
      </Text>
      <Text fontSize="11px" color="term.green" fontWeight="600" flexShrink={0}>
        {task.code}
      </Text>
      <Text
        fontSize="11px"
        color="term.ink"
        flexShrink={1}
        minW={0}
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
      >
        {task.name}
      </Text>
      <Box flex="1" />
      <Text
        fontSize="9px"
        color={task.enabled ? 'term.ink3' : 'term.red'}
        letterSpacing="0.02em"
        flexShrink={1}
        minW={0}
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
        textAlign="right"
      >
        {[
          ...task.conditions.map(formatCondition),
          task.enabled ? `↺${String(task.pushIntervalSec)}s` : 'off',
        ].join(', ')}
      </Text>
      <Text fontSize="9px" color={task.hitCount > 0 ? 'term.amber' : 'term.ink3'} flexShrink={0}>
        ✦{String(task.hitCount)}
      </Text>
    </Flex>
  );
}

function formatCondition(c: WatchCondition): string {
  if (c.kind === 'pct') {
    const sign = c.thresholdPct.startsWith('-') ? '' : '+';
    return `${c.baseline} ${sign}${c.thresholdPct}%`;
  }
  return `price ${c.op === 'gte' ? '≥' : '≤'} ${c.thresholdPrice}`;
}
