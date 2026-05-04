'use client';

/**
 * Watch (W-0) pane (`docs/modules/W-0-watch.md` §11).
 *
 * Subscribes to `/api/watch/stream` (SSE, 1 Hz) for live task state.
 * Inline `+ add` toggles `<WatchAddForm/>` for the create flow; per-row
 * × deletes via the BFF and lets the next SSE tick refresh the list.
 */

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { WatchTaskSchema, type WatchTask } from '@quant/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { Feat } from '../../lib/eqty/feat.js';
import { Pane } from '../shell/pane.js';
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
      // Browsers auto-reconnect; only surface the error before any
      // payload arrived — keep the last snapshot otherwise.
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

export function WatchPanel(): React.ReactElement {
  const state = useWatchStream();
  const [adding, setAdding] = useState(false);
  const tasks = state.kind === 'open' ? state.tasks : [];

  return (
    <Pane
      feat={Feat.Watch}
      right={
        <Flex gap="8px" align="center">
          <Text color="term.green">● {String(tasks.length)}</Text>
          <Button
            size="xs"
            variant="ghost"
            color="term.green"
            onClick={(): void => {
              setAdding((v) => !v);
            }}
          >
            {adding ? '×' : '+ add'}
          </Button>
        </Flex>
      }
    >
      <PanelBody
        state={state}
        tasks={tasks}
        adding={adding}
        onCloseAdd={(): void => {
          setAdding(false);
        }}
      />
    </Pane>
  );
}

interface BodyProps {
  readonly state: StreamState;
  readonly tasks: readonly WatchTask[];
  readonly adding: boolean;
  readonly onCloseAdd: () => void;
}

function PanelBody({ state, tasks, adding, onCloseAdd }: BodyProps): React.ReactElement {
  return (
    <Box
      position="relative"
      px="14px"
      py="12px"
      color="term.ink2"
      fontFamily="mono"
      fontSize="12px"
      lineHeight="1.7"
      flex="1"
    >
      {adding ? <WatchAddForm onClose={onCloseAdd} /> : null}
      <BodyStatus state={state} tasks={tasks} />
    </Box>
  );
}

function BodyStatus({
  state,
  tasks,
}: {
  readonly state: StreamState;
  readonly tasks: readonly WatchTask[];
}): React.ReactElement {
  if (state.kind === 'connecting') return <Text>connecting…</Text>;
  if (state.kind === 'error') {
    return <Text color="term.red">stream error: {state.message}</Text>;
  }
  if (tasks.length === 0) {
    return <Text color="term.ink3">no tasks. click + add.</Text>;
  }
  return (
    <Flex direction="column" gap="6px">
      {tasks.map((t) => (
        <Row key={`${t.market}:${t.code}`} task={t} />
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

function Row({ task }: { readonly task: WatchTask }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onDelete = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      setErr(await deleteTask(task));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex justify="space-between" align="center" gap="8px">
      <RowSummary task={task} err={err} />
      <Button
        size="xs"
        variant="ghost"
        color="term.red"
        disabled={busy}
        onClick={(): void => {
          void onDelete();
        }}
      >
        ×
      </Button>
    </Flex>
  );
}

function RowSummary({
  task,
  err,
}: {
  readonly task: WatchTask;
  readonly err: string | null;
}): React.ReactElement {
  return (
    <Box flex="1" minW={0}>
      <Text>
        [{task.market}] {task.code} · {task.name}{' '}
        <Text as="span" color="term.ink3">
          (hit={String(task.hitCount)})
        </Text>
      </Text>
      <Text color="term.ink3" fontSize="11px">
        {task.conditions.length} cond · push≥{String(task.pushIntervalSec)}s ·{' '}
        {task.enabled ? 'on' : 'off'}
        {err !== null ? (
          <Text as="span" color="term.red">
            {' '}
            · {err}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
