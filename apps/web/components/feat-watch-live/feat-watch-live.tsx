'use client';

/**
 * Watch (W-0) pane (`docs/modules/W-0-watch.md` §11).
 *
 * Subscribes to `/api/watch/stream` (SSE, 1 Hz) for live task state.
 * The add form is permanent at the top — no toggle. The task list is
 * grouped by condition signature (tasks with identical conditions
 * collapse into one block); each group header has a checkbox that
 * selects the whole group, an OVERRIDE action (visible when the group
 * is fully selected) that pushes its stocks/conditions back into the
 * add form, and a × that deletes the entire group.
 *
 * Body scrolls internally so a long task list never inflates the host
 * column. Per-row hover highlights the current task.
 */

import { Box, Checkbox, Flex, Text } from '@chakra-ui/react';
import { WatchSnapshotPayloadSchema, type WatchCondition, type WatchTask } from '@quant/shared';
import { useEffect, useMemo, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';
import { useSocketTopic } from '../../lib/socket/use-socket-topic.js';
import { FeatView } from '../feat-view/feat-view.js';
import { MonoButton } from '../ui/mono-button.js';
import { WatchAddForm, type PickedStock, type WatchAddInitial } from './watch-add-form.js';

type StreamState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'open'; readonly tasks: readonly WatchTask[] }
  | { readonly kind: 'error'; readonly message: string };

function useWatchStream(): StreamState {
  const remote = useSocketTopic('watch.snapshot', WatchSnapshotPayloadSchema);
  if (remote.status === 'open') return { kind: 'open', tasks: remote.snapshot };
  if (remote.status === 'connecting') return { kind: 'connecting' };
  return { kind: 'error', message: remote.message };
}

const taskKey = (t: Pick<WatchTask, 'market' | 'code'>): string => `${t.market}:${t.code}`;

function formatMinutes(secs: number): string {
  if (secs % 60 === 0) return `${String(secs / 60)}m`;
  return `${(secs / 60).toFixed(2)}m`;
}

function groupKeyOf(conditions: readonly WatchCondition[]): string {
  return JSON.stringify(conditions);
}

interface TaskGroup {
  readonly key: string;
  readonly conditions: readonly WatchCondition[];
  readonly intervalSec: number;
  readonly pushIntervalSec: number;
  readonly tasks: readonly WatchTask[];
}

function groupTasks(tasks: readonly WatchTask[]): readonly TaskGroup[] {
  const map = new Map<string, WatchTask[]>();
  for (const t of tasks) {
    const k = groupKeyOf(t.conditions);
    const arr = map.get(k);
    if (arr) arr.push(t);
    else map.set(k, [t]);
  }
  const groups: TaskGroup[] = [];
  for (const [k, ts] of map) {
    const first = ts[0];
    if (!first) continue;
    groups.push({
      key: k,
      conditions: first.conditions,
      intervalSec: first.intervalSec,
      pushIntervalSec: first.pushIntervalSec,
      tasks: ts,
    });
  }
  return groups;
}

export function FeatWatchLive(): React.ReactElement {
  const state = useWatchStream();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [groupBusy, setGroupBusy] = useState<ReadonlySet<string>>(new Set());
  const [formInitial, setFormInitial] = useState<WatchAddInitial | undefined>(undefined);
  const [formKey, setFormKey] = useState(0);
  const tasks = state.kind === 'open' ? state.tasks : [];
  const groups = useMemo(() => groupTasks(tasks), [tasks]);
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

  const markGroupBusy = (key: string, busy: boolean): void => {
    setGroupBusy((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const onToggleTask = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onToggleGroup = (group: TaskGroup): void => {
    const keys = group.tasks.map(taskKey);
    setSelected((prev) => {
      const allIn = keys.every((k) => prev.has(k));
      const next = new Set(prev);
      if (allIn) for (const k of keys) next.delete(k);
      else for (const k of keys) next.add(k);
      return next;
    });
  };

  const onDeleteGroup = async (group: TaskGroup): Promise<void> => {
    try {
      await guard({
        title: 'delete group',
        message: (
          <Text fontFamily="mono" fontSize="12px" color="term.ink2" lineHeight="1.7">
            delete{' '}
            <Text as="span" color="term.red">
              {group.tasks.length}
            </Text>{' '}
            watch tasks in this group? This cannot be undone.
          </Text>
        ),
        confirmLabel: 'DELETE',
      });
    } catch (e) {
      if (e instanceof ConfirmCancelled) return;
      throw e;
    }
    markGroupBusy(group.key, true);
    try {
      await Promise.all(group.tasks.map((t) => deleteTask(t)));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const t of group.tasks) next.delete(taskKey(t));
        return next;
      });
    } finally {
      markGroupBusy(group.key, false);
    }
  };

  const onDeleteSelected = async (): Promise<void> => {
    const keys = Array.from(selected);
    if (keys.length === 0) return;
    try {
      await guard({
        title: 'delete selected',
        message: (
          <Text fontFamily="mono" fontSize="12px" color="term.ink2" lineHeight="1.7">
            delete{' '}
            <Text as="span" color="term.red">
              {String(keys.length)}
            </Text>{' '}
            selected watch task(s)? This cannot be undone.
          </Text>
        ),
        confirmLabel: 'DELETE',
      });
    } catch (e) {
      if (e instanceof ConfirmCancelled) return;
      throw e;
    }
    const targets = tasks.filter((t) => selected.has(taskKey(t)));
    await Promise.all(targets.map((t) => deleteTask(t)));
    setSelected(new Set());
  };

  const onOverrideGroup = async (group: TaskGroup): Promise<void> => {
    const picked: readonly PickedStock[] = group.tasks.map((t) => ({
      market: t.market,
      code: t.code,
      name: t.name,
    }));
    markGroupBusy(group.key, true);
    try {
      await Promise.all(group.tasks.map((t) => deleteTask(t)));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const t of group.tasks) next.delete(taskKey(t));
        return next;
      });
      setFormInitial({
        picked,
        conditions: group.conditions,
        intervalSec: group.intervalSec,
        pushIntervalSec: group.pushIntervalSec,
      });
      setFormKey((k) => k + 1);
    } finally {
      markGroupBusy(group.key, false);
    }
  };

  return (
    <FeatView
      feat={Feat.WatchLive}
      status={state.kind === 'open' ? 'green' : state.kind === 'error' ? 'red' : 'idle'}
    >
      <Flex
        direction="column"
        flex="1"
        minH={0}
        color="term.ink2"
        fontFamily="mono"
        fontSize="12px"
        lineHeight="1.7"
      >
        <Box px="14px" pt="10px" flexShrink={0}>
          {formInitial ? (
            <WatchAddForm key={formKey} initial={formInitial} />
          ) : (
            <WatchAddForm key={formKey} />
          )}
        </Box>
        {selected.size > 0 && (
          <Flex
            align="center"
            gap="8px"
            px="14px"
            py="6px"
            mx="14px"
            borderWidth="1px"
            borderColor="term.amber"
            bg="term.panel"
            color="term.amber"
            fontFamily="mono"
            fontSize="11px"
            letterSpacing="0.06em"
            flexShrink={0}
          >
            <Text>selected {String(selected.size)} task(s)</Text>
            <Box ml="auto">
              <MonoButton
                icon="delete"
                label="clear selection"
                onClick={(): void => {
                  setSelected(new Set());
                }}
              >
                clear
              </MonoButton>
            </Box>
            <MonoButton
              icon="delete"
              label="delete selected"
              onClick={(): void => {
                void onDeleteSelected();
              }}
            >
              delete
            </MonoButton>
          </Flex>
        )}
        <Box px="14px" py="8px">
          <BodyStatus
            state={state}
            groups={groups}
            selected={selected}
            groupBusy={groupBusy}
            onToggleTask={onToggleTask}
            onToggleGroup={onToggleGroup}
            onDeleteGroup={(g): void => {
              void onDeleteGroup(g);
            }}
            onOverrideGroup={(g): void => {
              void onOverrideGroup(g);
            }}
          />
        </Box>
      </Flex>
      {confirmComp}
    </FeatView>
  );
}

interface BodyStatusProps {
  readonly state: StreamState;
  readonly groups: readonly TaskGroup[];
  readonly selected: ReadonlySet<string>;
  readonly groupBusy: ReadonlySet<string>;
  readonly onToggleTask: (key: string) => void;
  readonly onToggleGroup: (group: TaskGroup) => void;
  readonly onDeleteGroup: (group: TaskGroup) => void;
  readonly onOverrideGroup: (group: TaskGroup) => void;
}

function BodyStatus({
  state,
  groups,
  selected,
  groupBusy,
  onToggleTask,
  onToggleGroup,
  onDeleteGroup,
  onOverrideGroup,
}: BodyStatusProps): React.ReactElement {
  if (state.kind === 'connecting') return <Text>connecting…</Text>;
  if (state.kind === 'error') {
    return <Text color="term.red">stream error: {state.message}</Text>;
  }
  if (groups.length === 0) {
    return <Text color="term.ink3">no tasks. fill the form above to add.</Text>;
  }
  return (
    <Flex direction="column" gap="10px">
      {groups.map((g) => (
        <Group
          key={g.key}
          group={g}
          selected={selected}
          busy={groupBusy.has(g.key)}
          onToggleTask={onToggleTask}
          onToggleGroup={onToggleGroup}
          onDelete={onDeleteGroup}
          onOverride={onOverrideGroup}
        />
      ))}
    </Flex>
  );
}

interface GroupProps {
  readonly group: TaskGroup;
  readonly selected: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onToggleTask: (key: string) => void;
  readonly onToggleGroup: (group: TaskGroup) => void;
  readonly onDelete: (group: TaskGroup) => void;
  readonly onOverride: (group: TaskGroup) => void;
}

function Group({
  group,
  selected,
  busy,
  onToggleTask,
  onToggleGroup,
  onDelete,
  onOverride,
}: GroupProps): React.ReactElement {
  const taskKeys = group.tasks.map(taskKey);
  const selectedInGroup = taskKeys.filter((k) => selected.has(k)).length;
  const allSelected = selectedInGroup === taskKeys.length && taskKeys.length > 0;
  const partiallySelected = selectedInGroup > 0 && !allSelected;
  const titleLines: readonly string[] = [
    ...group.conditions.map(formatCondition),
    `interval: ${formatMinutes(group.intervalSec)}  push≥: ${formatMinutes(group.pushIntervalSec)}  drift≥2%`,
  ];

  return (
    <Box borderWidth="1px" borderColor="term.line" bg="transparent">
      <Flex
        align="center"
        gap="6px"
        px="6px"
        py="3px"
        bg={allSelected ? 'term.panel' : 'term.bgElev'}
        borderBottomWidth="1px"
        borderColor="term.line"
        cursor="pointer"
        _hover={{ bg: 'term.panel2' }}
        onClick={(): void => {
          onToggleGroup(group);
        }}
      >
        <Checkbox.Root
          checked={allSelected ? true : partiallySelected ? 'indeterminate' : false}
          size="sm"
          colorPalette="green"
          flexShrink={0}
          onClick={(e): void => {
            e.stopPropagation();
            onToggleGroup(group);
          }}
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
        </Checkbox.Root>
        <Flex direction="column" flex="1" minW={0} gap="0">
          {titleLines.length > 0 ? (
            titleLines.map((line, i) => (
              <Text
                key={`line-${String(i)}`}
                fontSize="10px"
                lineHeight="1.2"
                color="term.ink"
                fontFamily="mono"
                fontWeight="600"
                whiteSpace="normal"
                wordBreak="break-word"
              >
                {line}
              </Text>
            ))
          ) : (
            <Text
              fontSize="10px"
              lineHeight="1.2"
              color="term.ink3"
              fontFamily="mono"
              fontWeight="600"
            >
              (no conditions)
            </Text>
          )}
        </Flex>
        <Text fontSize="10px" color="term.ink3" letterSpacing="0.14em" flexShrink={0}>
          ×{group.tasks.length}
        </Text>
        {allSelected ? (
          <MonoButton
            icon="refresh"
            label="override (re-edit) this group"
            disabled={busy}
            onClick={(e: React.MouseEvent<HTMLButtonElement>): void => {
              e.stopPropagation();
              onOverride(group);
            }}
          >
            OVERRIDE
          </MonoButton>
        ) : null}
        <MonoButton
          icon="delete"
          label="delete group"
          disabled={busy}
          onClick={(e: React.MouseEvent<HTMLButtonElement>): void => {
            e.stopPropagation();
            onDelete(group);
          }}
        />
      </Flex>
      <Flex direction="column">
        {group.tasks.map((t) => (
          <Row
            key={taskKey(t)}
            task={t}
            checked={selected.has(taskKey(t))}
            onToggle={(): void => {
              onToggleTask(taskKey(t));
            }}
          />
        ))}
      </Flex>
    </Box>
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
      px="6px"
      py="2px"
      borderBottomWidth="1px"
      borderColor="term.line2"
      cursor="pointer"
      bg={checked ? 'term.panel' : 'transparent'}
      transition="background 120ms ease, color 120ms ease"
      _hover={{ bg: 'term.panel2' }}
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
        flexShrink={0}
      >
        {task.enabled ? `↺${formatMinutes(task.pushIntervalSec)}` : 'off'}
      </Text>
      <Text fontSize="9px" color={task.hitCount > 0 ? 'term.amber' : 'term.ink3'} flexShrink={0}>
        ✦{String(task.hitCount)}
      </Text>
    </Flex>
  );
}

function formatCondition(c: WatchCondition): string {
  const op = c.op === 'gte' ? '≥' : '≤';
  if (c.kind === 'pct') {
    const base =
      c.baseline === 'trend' && c.window !== undefined
        ? `trend(${String(c.window)}s)`
        : c.baseline;
    return `pct($, ${base}) ${op} ${c.thresholdPct}%`;
  }
  return `abs($) ${op} ${c.thresholdPrice}`;
}
