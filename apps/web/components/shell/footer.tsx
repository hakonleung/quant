'use client';

/**
 * Status footer.
 *
 * Each strip is a "feat capsule" — a compact, framed status read for
 * one workbench surface. The 300 task-queue capsule lives here too
 * (it replaces the previous full-pane TaskQueuePanel), so the right
 * column stays focused on the active stock.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { QueueSnapshotEntry } from '@quant/shared';
import { useEffect, useState, type ReactNode } from 'react';

import { useQueueStream } from '../../lib/hooks/use-queue-stream.js';

export function Footer(): React.ReactElement {
  const stream = useQueueStream();
  const now = useClock();

  const sseLabel =
    stream.status === 'open'
      ? 'live'
      : stream.status === 'connecting'
        ? 'connecting'
        : 'lost';
  const sseColor =
    stream.status === 'open' ? 'prompt' : stream.status === 'error' ? 'up' : 'accent';
  const sseGlyph = stream.status === 'open' ? '●' : stream.status === 'error' ? '✘' : '○';

  const queues: readonly QueueSnapshotEntry[] = stream.snapshot?.queues ?? [];

  return (
    <Flex
      h="22px"
      bg="panel"
      color="ink3"
      borderTopWidth="2px"
      borderTopColor="accent"
      align="stretch"
      fontFamily="mono"
      fontSize="10px"
      letterSpacing="0.14em"
    >
      <Capsule code="SSE">
        <Text as="span" color={sseColor}>
          {sseGlyph}
        </Text>
        <Text as="span" color={sseColor}>
          {sseLabel}
        </Text>
      </Capsule>
      <Capsule code="300" label="QUEUE">
        <QueueCapsuleBody queues={queues} />
      </Capsule>
      <Capsule code="IDB">persist</Capsule>
      <Box flex="1" />
      <Capsule code="UTC">
        <Text as="span">{now}</Text>
        <Text as="span" className="blink" color="prompt">
          ●
        </Text>
      </Capsule>
    </Flex>
  );
}

interface CapsuleProps {
  readonly code: string;
  readonly label?: string;
  readonly children: ReactNode;
}

function Capsule({ code, label, children }: CapsuleProps): React.ReactElement {
  return (
    <Flex
      align="center"
      gap="6px"
      px="10px"
      borderRightWidth="1px"
      borderColor="line2"
      whiteSpace="nowrap"
    >
      <Text color="accent" fontWeight="700" letterSpacing="0.18em">
        {code}
      </Text>
      {label !== undefined && (
        <Text color="ink3" letterSpacing="0.18em">
          {label}
        </Text>
      )}
      {children}
    </Flex>
  );
}

function QueueCapsuleBody({
  queues,
}: {
  queues: readonly QueueSnapshotEntry[];
}): React.ReactElement {
  if (queues.length === 0) {
    return <Text color="ink3">— idle</Text>;
  }
  return (
    <Flex gap="8px" align="center">
      {queues.map((q) => {
        const busy = q.inFlight > 0 || q.pending > 0;
        const color = q.paused ? 'accent' : busy ? 'up' : 'prompt';
        return (
          <Flex key={q.name} gap="3px" align="center" color={color}>
            <Text>{q.name}</Text>
            <Text fontWeight="700">
              {String(q.inFlight)}/{String(q.pending)}
            </Text>
          </Flex>
        );
      })}
    </Flex>
  );
}

function useClock(): string {
  const [iso, setIso] = useState<string>(() => formatNow());
  useEffect(() => {
    const t = setInterval(() => {
      setIso(formatNow());
    }, 1000);
    return (): void => {
      clearInterval(t);
    };
  }, []);
  return iso;
}

function formatNow(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${date} ${time}`;
}
