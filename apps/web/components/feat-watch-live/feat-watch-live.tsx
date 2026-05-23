'use client';

/**
 * Watch (W-0) pane (`docs/modules/W-0-watch.md` §11).
 *
 * Subscribes to the `watch.snapshot` Socket.IO topic (1 Hz) for live
 * task state — see `docs/modules/12-socket.md`.
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
import {
  WatchSnapshotPayloadSchema,
  type WatchCondition,
  type WatchGroup,
  type WatchTask,
} from '@quant/shared';
import { useEffect, useMemo, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';
import { useViewport } from '../../lib/hooks/use-viewport.js';
import { useSocketTopic } from '../../lib/socket/use-socket-topic.js';
import { FeatView } from '../feat-view/feat-view.js';
import { MonoButton } from '../ui/mono-button.js';
import { useWatchGroups } from './use-watch-groups.js';
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

interface TaskGroup {
  /** Group name; doubles as the React key and the API path segment. */
  readonly key: string;
  readonly name: string;
  readonly conditions: readonly WatchCondition[];
  readonly intervalSec: number;
  readonly pushIntervalSec: number;
  /**
   * Group-level monitoring switch. `false` means the scheduler skips
   * every task in this group — render the row dimmed and surface a
   * resume affordance instead of suggesting it's still ticking. Falls
   * back to `true` for tasks whose group config hasn't loaded yet.
   */
  readonly enabled: boolean;
  readonly tasks: readonly WatchTask[];
}

/**
 * Bucket tasks by their `groupName`, hydrating header conds/intervals
 * from the persisted `WatchGroup` config when one exists. Tasks whose
 * group has been deleted server-side (or that arrived before the group
 * snapshot) fall back to their own `conditions / intervalSec` so the
 * row is still rendered usefully.
 */
function groupTasks(
  tasks: readonly WatchTask[],
  groupConfigs: readonly WatchGroup[],
): readonly TaskGroup[] {
  const configByName = new Map<string, WatchGroup>();
  for (const g of groupConfigs) configByName.set(g.name, g);
  const buckets = new Map<string, WatchTask[]>();
  for (const t of tasks) {
    const arr = buckets.get(t.groupName);
    if (arr) arr.push(t);
    else buckets.set(t.groupName, [t]);
  }
  const out: TaskGroup[] = [];
  for (const [name, ts] of buckets) {
    const cfg = configByName.get(name);
    const first = ts[0];
    if (!first) continue;
    out.push({
      key: name,
      name,
      conditions: cfg?.conditions ?? first.conditions,
      intervalSec: cfg?.intervalSec ?? first.intervalSec,
      pushIntervalSec: cfg?.pushIntervalSec ?? first.pushIntervalSec,
      enabled: cfg?.enabled ?? true,
      tasks: ts,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

interface FeatWatchLiveProps {
  /** Hosted inside USR.MAIN as a tab — drop the FeatView chrome. */
  readonly bare?: boolean;
}

export function FeatWatchLive({ bare }: FeatWatchLiveProps = {}): React.ReactElement {
  const state = useWatchStream();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [groupBusy, setGroupBusy] = useState<ReadonlySet<string>>(new Set());
  const [formInitial, setFormInitial] = useState<WatchAddInitial | undefined>(undefined);
  const [formKey, setFormKey] = useState(0);
  // The 800-line WatchAddForm dominates the screen on a phone — keep
  // it collapsed by default below the breakpoint so the live task
  // list stays in view, and surface a "+ NEW WATCH" trigger that
  // expands it on demand. Desktop / tablet keep the existing always-
  // open behaviour (no extra click for power users).
  const { mode: vpMode } = useViewport();
  const isMobile = vpMode === 'mobile';
  const [formOpen, setFormOpen] = useState(!isMobile);
  // OVERRIDE flow always pops the form open even on mobile so the
  // user immediately sees the prefilled state.
  useEffect(() => {
    if (formInitial !== undefined) setFormOpen(true);
  }, [formInitial]);
  const tasks = state.kind === 'open' ? state.tasks : [];
  const { groups: groupConfigs, refresh: refreshGroupConfigs } = useWatchGroups();
  const groups = useMemo(() => groupTasks(tasks, groupConfigs), [tasks, groupConfigs]);
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
            delete group{' '}
            <Text as="span" color="term.amber">
              {group.name}
            </Text>{' '}
            and its{' '}
            <Text as="span" color="term.red">
              {group.tasks.length}
            </Text>{' '}
            watch tasks? This also removes the group's stored conds and cannot be undone.
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
      await deleteGroup(group.name);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const t of group.tasks) next.delete(taskKey(t));
        return next;
      });
      refreshGroupConfigs();
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

  const onToggleGroupEnabled = async (group: TaskGroup): Promise<void> => {
    markGroupBusy(group.key, true);
    try {
      await patchGroup(group.name, { enabled: !group.enabled });
      refreshGroupConfigs();
    } finally {
      markGroupBusy(group.key, false);
    }
  };

  const onOverrideGroup = async (group: TaskGroup): Promise<void> => {
    const picked: readonly PickedStock[] = group.tasks.map((t) => ({
      market: t.market,
      code: t.code,
      name: t.name,
    }));
    markGroupBusy(group.key, true);
    try {
      await deleteGroup(group.name);
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
      refreshGroupConfigs();
    } finally {
      markGroupBusy(group.key, false);
    }
  };

  return (
    <FeatView
      feat={Feat.WatchLive}
      bare={bare ?? false}
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
          {isMobile && !formOpen ? (
            <Flex
              as="button"
              role="button"
              w="100%"
              h="36px"
              align="center"
              justify="center"
              gap="8px"
              border="1px dashed"
              borderColor="term.line"
              bg="term.bgElev"
              color="term.green"
              fontFamily="mono"
              fontSize="12px"
              letterSpacing="0.18em"
              cursor="pointer"
              _hover={{ bg: 'term.panel2' }}
              _focusVisible={{ outline: '2px solid', outlineColor: 'term.green', outlineOffset: '-2px' }}
              aria-expanded={false}
              aria-label="open new watch form"
              onClick={(): void => {
                setFormOpen(true);
              }}
            >
              + NEW WATCH
            </Flex>
          ) : (
            <Box position="relative">
              {isMobile && (
                <Flex justify="flex-end" mb="4px">
                  <MonoButton
                    icon="close"
                    label="collapse new watch form"
                    onClick={(): void => {
                      setFormOpen(false);
                    }}
                  />
                </Flex>
              )}
              {formInitial ? (
                <WatchAddForm
                  key={formKey}
                  initial={formInitial}
                  onSubmitted={(): void => {
                    refreshGroupConfigs();
                    if (isMobile) setFormOpen(false);
                  }}
                />
              ) : (
                <WatchAddForm
                  key={formKey}
                  onSubmitted={(): void => {
                    refreshGroupConfigs();
                    if (isMobile) setFormOpen(false);
                  }}
                />
              )}
            </Box>
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
            onToggleEnabled={(g): void => {
              void onToggleGroupEnabled(g);
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
  readonly onToggleEnabled: (group: TaskGroup) => void;
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
  onToggleEnabled,
}: BodyStatusProps): React.ReactElement {
  if (state.kind === 'connecting') {
    return (
      <Text role="status" aria-live="polite">
        connecting…
      </Text>
    );
  }
  if (state.kind === 'error') {
    return (
      <Text role="status" aria-live="polite" color="term.red">
        stream error: {state.message}
      </Text>
    );
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
          onToggleEnabled={onToggleEnabled}
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
  readonly onToggleEnabled: (group: TaskGroup) => void;
}

function Group({
  group,
  selected,
  busy,
  onToggleTask,
  onToggleGroup,
  onDelete,
  onOverride,
  onToggleEnabled,
}: GroupProps): React.ReactElement {
  const taskKeys = group.tasks.map(taskKey);
  const selectedInGroup = taskKeys.filter((k) => selected.has(k)).length;
  const allSelected = selectedInGroup === taskKeys.length && taskKeys.length > 0;
  const partiallySelected = selectedInGroup > 0 && !allSelected;
  const titleLines: readonly string[] = [
    `${group.name} · ${group.conditions.map(formatCondition).join(' / ')}`,
    `interval: ${formatMinutes(group.intervalSec)}  push≥: ${formatMinutes(group.pushIntervalSec)}  drift≥2%`,
  ];

  return (
    <Box
      borderWidth="1px"
      borderColor="term.line"
      bg="transparent"
      opacity={group.enabled ? 1 : 0.55}
    >
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
        {!group.enabled && (
          <Text
            fontSize="9px"
            color="term.red"
            letterSpacing="0.18em"
            fontWeight="600"
            flexShrink={0}
          >
            PAUSED
          </Text>
        )}
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
          icon={group.enabled ? 'block' : 'push'}
          label={group.enabled ? 'pause monitoring for this group' : 'resume monitoring'}
          disabled={busy}
          onClick={(e: React.MouseEvent<HTMLButtonElement>): void => {
            e.stopPropagation();
            onToggleEnabled(group);
          }}
        >
          {group.enabled ? 'PAUSE' : 'RESUME'}
        </MonoButton>
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

async function patchGroup(name: string, body: { readonly enabled?: boolean }): Promise<void> {
  const res = await fetch(`/api/watch/groups/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`group patch failed: ${String(res.status)} ${text.slice(0, 100)}`);
  }
}

async function deleteGroup(name: string): Promise<void> {
  const res = await fetch(`/api/watch/groups/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.text();
    throw new Error(`group delete failed: ${String(res.status)} ${body.slice(0, 100)}`);
  }
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
  // `flexWrap: wrap` lets the status badges (push-interval / hit count)
  // drop to a second line when the column is narrow (mobile shell or
  // a tightly-dragged right column). On wider hosts everything stays
  // on one row — no layout regression on desktop.
  return (
    <Flex flex="1" minW={0} align="baseline" gap="6px" lineHeight="1.3" flexWrap="wrap">
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
      <Flex align="baseline" gap="6px" flexShrink={0}>
        <Text fontSize="9px" color={task.enabled ? 'term.ink3' : 'term.red'} letterSpacing="0.02em">
          {task.enabled ? `↺${formatMinutes(task.pushIntervalSec)}` : 'off'}
        </Text>
        <Text fontSize="9px" color={task.hitCount > 0 ? 'term.amber' : 'term.ink3'}>
          ✦{String(task.hitCount)}
        </Text>
      </Flex>
    </Flex>
  );
}

function formatCondition(c: WatchCondition): string {
  if (c.kind === 'ma') {
    const arrow = c.op === 'crossUp' ? '↑' : '↓';
    return `${c.indicator.toUpperCase()} ${arrow} ${c.op}`;
  }
  const op = c.op === 'gte' ? '≥' : '≤';
  if (c.kind === 'pct') {
    const base =
      c.baseline === 'trend' && c.window !== undefined ? `trend(${String(c.window)}s)` : c.baseline;
    return `pct($, ${base}) ${op} ${c.thresholdPct}%`;
  }
  return `abs($) ${op} ${c.thresholdPrice}`;
}
