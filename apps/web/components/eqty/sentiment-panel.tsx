'use client';

import { Box, Button, Grid, Text } from '@chakra-ui/react';
import type { Sentiment } from '@quant/shared';

import { useAnalyzeSentiment, useSentiment } from '../../lib/hooks/use-eqty-data.js';
import { Pane } from '../shell/pane.js';

interface Props {
  readonly code: string;
  /**
   * Bubbles the latest analysis result up to the page so siblings (e.g.
   * the Slack panel) can render the same payload — Sentiment data lives
   * here, not in a global store, because it's per-stock + paid LLM.
   */
  readonly onResult?: (s: Sentiment) => void;
}

export function SentimentPanel({ code, onResult }: Props): React.ReactElement {
  // Default render path is the cache-only GET — never invokes the LLM.
  const cached = useSentiment(code);
  // FETCH button → POST → on success the hook invalidates the GET
  // query so `cached.data` re-flows from the warm cache.
  const analyze = useAnalyzeSentiment(code);

  const onFetch = (): void => {
    analyze.mutate(undefined, {
      onSuccess: (data) => {
        onResult?.(data);
      },
    });
  };

  // Surface the latest cached row to siblings on first arrival too.
  if (cached.data && cached.data !== analyze.data && onResult !== undefined) {
    onResult(cached.data);
  }

  const value = cached.data ?? null;
  const right = analyze.isPending ? (
    <Text color="accent">● analyzing</Text>
  ) : value !== null ? (
    <Text>cached {formatTime(value.cachedAt)}</Text>
  ) : cached.isLoading ? (
    <Text>loading…</Text>
  ) : analyze.isError ? (
    <Text color="up">✘ {analyze.error.message}</Text>
  ) : (
    <Text>no cache</Text>
  );

  return (
    <Pane id="200" title="Sentiment Snapshot" gridArea="R1" right={right}>
      {analyze.isPending && value === null ? (
        <EmptyMsg>analyzing… (LLM)</EmptyMsg>
      ) : value === null ? (
        <Idle onFetch={onFetch} />
      ) : (
        <SentimentGrid s={value} onFetch={onFetch} loading={analyze.isPending} />
      )}
    </Pane>
  );
}

function Idle({ onFetch }: { onFetch: () => void }): React.ReactElement {
  return (
    <Box px="12px" py="14px" display="flex" alignItems="center" gap="12px">
      <Text fontFamily="mono" fontSize="11px" color="ink3" letterSpacing="0.12em">
        // 尚无消息面 — click FETCH to analyze
      </Text>
      <FetchButton onClick={onFetch} loading={false} />
    </Box>
  );
}

function SentimentGrid({
  s,
  onFetch,
  loading,
}: {
  s: Sentiment;
  onFetch: () => void;
  loading: boolean;
}): React.ReactElement {
  return (
    <Grid templateColumns="repeat(2, 1fr)" gap="1px" bg="line">
      <Cell label="SCORE">
        <Box as="span" fontFamily="mono" color="up" fontWeight="700">
          {s.score.toFixed(2)}
        </Box>{' '}
        <Box as="span" color="accent">
          {stars(s.score)}
        </Box>
      </Cell>
      <Cell label="THEME">{s.theme}</Cell>
      <Cell label="DRIVER" small>
        {s.driver}
      </Cell>
      <Cell label="TARGET">
        <Box as="span" fontFamily="mono" color="up" fontWeight="700">
          {s.target >= 0 ? '+' : ''}
          {s.target.toFixed(1)}%
        </Box>
      </Cell>
      <Cell label="RUMOR" small>
        <Box as="span" color="violet">
          ⚠ {s.rumor || '—'}
        </Box>
      </Cell>
      <Cell label="REFRESH">
        <FetchButton onClick={onFetch} loading={loading} />
      </Cell>
    </Grid>
  );
}

function FetchButton({ onClick, loading }: { onClick: () => void; loading: boolean }): React.ReactElement {
  return (
    <Button
      bg="accent"
      color="panel"
      h="auto"
      px="12px"
      py="5px"
      fontFamily="mono"
      fontSize="10px"
      fontWeight="600"
      letterSpacing="0.16em"
      borderRadius="0"
      onClick={onClick}
      loading={loading}
      _hover={{ bg: 'accentDark' }}
    >
      ⟳ FETCH
    </Button>
  );
}

function stars(score: number): string {
  const filled = Math.round(score * 5);
  return '★★★★★'.slice(0, filled) + '☆☆☆☆☆'.slice(0, 5 - filled);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function Cell({ label, children, small = false }: { label: string; children: React.ReactNode; small?: boolean }): React.ReactElement {
  return (
    <Box bg="panel" px="12px" py="9px">
      <Text color="ink3" fontSize="10px" letterSpacing="0.16em" textTransform="uppercase" fontWeight="700" fontFamily="mono">
        {label}
      </Text>
      <Box color="ink" fontSize={small ? '11px' : '13px'} mt="5px" fontWeight="600">
        {children}
      </Box>
    </Box>
  );
}

function EmptyMsg({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text px="12px" py="14px" fontFamily="mono" fontSize="11px" color="ink3" letterSpacing="0.12em">
      {children}
    </Text>
  );
}
