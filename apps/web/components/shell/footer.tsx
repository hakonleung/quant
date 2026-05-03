'use client';

import { Box, Flex, HStack, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';

import { useQueueStream } from '../../lib/hooks/use-queue-stream.js';

export function Footer(): React.ReactElement {
  const stream = useQueueStream();
  const now = useClock();

  const rpc =
    stream.status === 'open'
      ? '● live'
      : stream.status === 'connecting'
        ? '○ connecting'
        : '✘ stream lost';
  const queueDepth =
    stream.snapshot?.queues.reduce((acc, q) => acc + q.pending + q.inFlight, 0) ?? 0;

  return (
    <Flex
      h="22px"
      bg="panel"
      color="ink3"
      borderTopWidth="2px"
      borderTopColor="accent"
      align="center"
      gap="14px"
      px="14px"
      fontFamily="mono"
      fontSize="10px"
      letterSpacing="0.18em"
    >
      <Text
        color={stream.status === 'open' ? 'prompt' : stream.status === 'error' ? 'up' : 'accent'}
      >
        {rpc}
      </Text>
      <Text>QUEUE {queueDepth}</Text>
      <Text color="ink3">PERSIST: indexedDB(quant-app v3)</Text>
      <HStack gap="14px" ml="auto">
        <Text>
          {now}{' '}
          <Box as="span" className="blink" color="prompt">
            ●
          </Box>
        </Text>
      </HStack>
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
