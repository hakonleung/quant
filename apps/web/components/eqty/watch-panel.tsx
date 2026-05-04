'use client';

/**
 * Watch (W-0) pane (`docs/modules/W-0-watch.md` §11).
 *
 * Subscribes to `/api/watch/stream` (SSE, 1 Hz). The Nest gateway
 * pushes a fresh task list each tick so `lastTickAt` / `hitCount`
 * updates land within ~1s of the scheduler mutating them — no polling.
 *
 * Read-only v0: list existing tasks, show last hit + push state.
 * Editor (add / patch / delete) lands in a follow-up; for the MVP a
 * direct `POST /api/watch` does the job.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import { WatchTaskSchema, type WatchTask } from '@quant/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { Feat } from '../../lib/eqty/feat.js';
import { Pane } from '../shell/pane.js';

const TaskListSchema = z.array(WatchTaskSchema);

type StreamState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'open'; readonly tasks: readonly WatchTask[] }
  | { readonly kind: 'error'; readonly message: string };

export function WatchPanel(): React.ReactElement {
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
      // Browsers auto-reconnect; only surface the error if we never
      // received a payload, otherwise keep showing the last snapshot.
      if (stateRef.current.kind !== 'open') {
        setState({ kind: 'error', message: 'stream disconnected' });
      }
    };

    return (): void => {
      es.close();
    };
  }, []);

  const tasks = state.kind === 'open' ? state.tasks : [];

  return (
    <Pane feat={Feat.Watch} right={<Text color="term.green">● {String(tasks.length)}</Text>}>
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
        {state.kind === 'connecting' ? (
          <Text>connecting…</Text>
        ) : state.kind === 'error' ? (
          <Text color="term.red">stream error: {state.message}</Text>
        ) : tasks.length === 0 ? (
          <Text color="term.ink3">no tasks. POST /api/watch to add.</Text>
        ) : (
          <Flex direction="column" gap="6px">
            {tasks.map((t) => (
              <Row key={`${t.market}:${t.code}`} task={t} />
            ))}
          </Flex>
        )}
      </Box>
    </Pane>
  );
}

function Row({ task }: { readonly task: WatchTask }): React.ReactElement {
  return (
    <Flex justify="space-between" align="center" gap="8px">
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
        </Text>
      </Box>
    </Flex>
  );
}
