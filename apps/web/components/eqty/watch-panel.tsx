'use client';

/**
 * Watch (W-0) pane (`docs/modules/W-0-watch.md` §11).
 *
 * Minimal v0 surface — list existing tasks, show last hit + push time,
 * delete inline. Editor (add / patch) and condition rich-form land in a
 * follow-up — for the MVP a JSON-backed POST does the job.
 *
 * The list polls `/api/watch` every 5s via react-query (≤30 rows expected
 * — virtualization deliberately skipped).
 */

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WatchTask } from '@quant/shared';

import { Feat } from '../../lib/eqty/feat.js';
import { Pane } from '../shell/pane.js';

const WATCH_KEY = ['watch'];

async function fetchWatchTasks(): Promise<readonly WatchTask[]> {
  const res = await fetch('/api/watch', { cache: 'no-store' });
  if (!res.ok) throw new Error(`watch list ${String(res.status)}`);
  return res.json() as Promise<readonly WatchTask[]>;
}

async function deleteWatchTask(market: WatchTask['market'], code: string): Promise<void> {
  const res = await fetch(`/api/watch/${market}/${encodeURIComponent(code)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) throw new Error(`watch delete ${String(res.status)}`);
}

export function WatchPanel(): React.ReactElement {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: WATCH_KEY,
    queryFn: fetchWatchTasks,
    refetchInterval: 5_000,
  });
  const del = useMutation({
    mutationFn: ({ market, code }: { market: WatchTask['market']; code: string }) =>
      deleteWatchTask(market, code),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCH_KEY }),
  });

  return (
    <Pane feat={Feat.Watch} right={<Text color="term.green">● {String(data?.length ?? 0)}</Text>}>
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
        {isLoading ? (
          <Text>loading…</Text>
        ) : error !== null ? (
          <Text color="term.red">load failed: {String(error.message)}</Text>
        ) : data === undefined || data.length === 0 ? (
          <Text color="term.ink3">no tasks. POST /api/watch to add.</Text>
        ) : (
          <Flex direction="column" gap="6px">
            {data.map((t) => (
              <Row key={`${t.market}:${t.code}`} task={t} onDelete={(): void => del.mutate({ market: t.market, code: t.code })} />
            ))}
          </Flex>
        )}
      </Box>
    </Pane>
  );
}

function Row({
  task,
  onDelete,
}: {
  readonly task: WatchTask;
  readonly onDelete: () => void;
}): React.ReactElement {
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
          {task.conditions.length} cond · push≥{String(task.pushIntervalSec)}s · {task.enabled ? 'on' : 'off'}
        </Text>
      </Box>
      <Button size="xs" variant="ghost" onClick={onDelete} color="term.red">
        ×
      </Button>
    </Flex>
  );
}
