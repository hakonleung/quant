'use client';

import { Box, Flex, Grid, Text } from '@chakra-ui/react';
import type { QueueSnapshotEntry } from '@quant/shared';

import { Feat } from '../../lib/eqty/feat.js';
import { useQueueStream } from '../../lib/hooks/use-queue-stream.js';
import { Pane } from '../shell/pane.js';

export function TaskQueuePanel(): React.ReactElement {
  const stream = useQueueStream();

  const right = (() => {
    if (stream.status === 'connecting') return <Text color="term.amber">○ connecting</Text>;
    if (stream.status === 'error') return <Text color="term.red">✘ stream lost</Text>;
    return <Text color="term.green">● live</Text>;
  })();

  return (
    <Pane feat={Feat.TaskQueue} right={right}>
      <Box
        position="relative"
        px="18px"
        py="14px"
        bg="term.panel"
        color="term.ink2"
        fontFamily="mono"
        fontSize="12px"
        lineHeight="1.7"
        h="100%"
        overflow="auto"
        backgroundImage="radial-gradient(800px 300px at 80% -20%, rgba(94,255,156,0.05), transparent 60%), radial-gradient(600px 300px at 0% 120%, rgba(92,242,255,0.04), transparent 60%)"
        _after={{
          content: '""',
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'repeating-linear-gradient(to bottom, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px)',
        }}
      >
        <Flex gap="10px" position="relative" zIndex={1}>
          <Text color="term.green" fontWeight="700">
            $
          </Text>
          <Text>
            sentinel --watch{' '}
            <Box as="span" color="term.cyan">
              meta,kline
            </Box>
          </Text>
        </Flex>
        <Text mt="4px" position="relative" zIndex={1} color="term.ink3" fontSize="10px" letterSpacing="0.14em">
          {stream.snapshot === null
            ? 'awaiting first frame…'
            : `tick ${formatTs(stream.snapshot.ts)}`}
        </Text>

        {stream.snapshot === null ? (
          <Text
            mt="10px"
            position="relative"
            zIndex={1}
            color="term.ink3"
            fontSize="11px"
            letterSpacing="0.12em"
          >
            // no data yet
          </Text>
        ) : (
          <Box mt="10px" position="relative" zIndex={1}>
            {stream.snapshot.queues.map((q) => (
              <QueueRow key={q.name} q={q} />
            ))}
          </Box>
        )}
      </Box>
    </Pane>
  );
}

function QueueRow({ q }: { q: QueueSnapshotEntry }): React.ReactElement {
  const busy = q.inFlight > 0 || q.pending > 0;
  return (
    <Box mb="10px">
      <Flex align="center" gap="10px">
        <Text color="term.cyan" fontSize="11px" minW="60px">
          ▎ {q.name.toUpperCase()}
        </Text>
        <Text color={q.paused ? 'term.amber' : busy ? 'term.green' : 'term.ink3'} fontSize="11px" letterSpacing="0.14em">
          {q.paused ? 'PAUSED' : busy ? 'WORKING' : 'IDLE'}
        </Text>
        {!q.paused && busy && <Text className="blink" color="term.green">●</Text>}
      </Flex>
      <Grid templateColumns="repeat(2, 1fr)" gap="6px" mt="4px" pl="14px">
        <Stat label="pending" value={q.pending} accent={q.pending > 0 ? 'term.amber' : 'term.ink2'} />
        <Stat label="in-flight" value={q.inFlight} accent={q.inFlight > 0 ? 'term.green' : 'term.ink2'} />
      </Grid>
      <PulseBar active={q.inFlight} pending={q.pending} />
    </Box>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }): React.ReactElement {
  return (
    <Flex align="center" gap="6px">
      <Text color="term.ink3" fontSize="10px" letterSpacing="0.14em" textTransform="uppercase">
        {label}
      </Text>
      <Text color={accent} fontFamily="mono" fontSize="13px" fontWeight="700">
        {value}
      </Text>
    </Flex>
  );
}

function PulseBar({ active, pending }: { active: number; pending: number }): React.ReactElement {
  const total = Math.max(active + pending, 1);
  const activePct = (active / total) * 100;
  const pendingPct = (pending / total) * 100;
  return (
    <Box mt="6px" ml="14px" h="4px" bg="term.line" position="relative" overflow="hidden">
      <Box position="absolute" left="0" top="0" bottom="0" w={`${String(activePct)}%`} bg="term.green" />
      <Box position="absolute" left={`${String(activePct)}%`} top="0" bottom="0" w={`${String(pendingPct)}%`} bg="term.amber" opacity="0.6" />
    </Box>
  );
}

function formatTs(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}
