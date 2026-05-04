'use client';

/**
 * Debounced ticker existence check for the Watch add-form.
 *
 * Calls `/api/watch/lookup?market=&code=` after the user pauses typing.
 * The form gates its submit button on `kind === 'found'` so the user
 * can't post a task whose `(market, code)` is unknown to the gateway
 * (which would otherwise surface as an akshare error mid-tick).
 */

import { Text } from '@chakra-ui/react';
import {
  isValidWatchCode,
  StockBasicSchema,
  type StockBasic,
  type WatchMarket,
} from '@quant/shared';
import { useEffect, useState } from 'react';

export type LookupState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'invalid' } // code regex fails for the market
  | { readonly kind: 'checking' }
  | { readonly kind: 'found'; readonly stock: StockBasic }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly message: string };

const DEBOUNCE_MS = 300;

async function fetchLookup(
  market: WatchMarket,
  code: string,
  signal: AbortSignal,
): Promise<LookupState> {
  const params = new URLSearchParams({ market, code });
  const res = await fetch(`/api/watch/lookup?${params.toString()}`, { signal });
  if (res.status === 404) return { kind: 'missing' };
  if (!res.ok) return { kind: 'error', message: `lookup ${String(res.status)}` };
  const raw: unknown = await res.json();
  return { kind: 'found', stock: StockBasicSchema.parse(raw) };
}

export function useStockLookup(market: WatchMarket, code: string): LookupState {
  const [state, setState] = useState<LookupState>({ kind: 'idle' });
  const trimmed = code.trim();

  useEffect(() => {
    if (trimmed === '') {
      setState({ kind: 'idle' });
      return;
    }
    if (!isValidWatchCode(market, trimmed)) {
      setState({ kind: 'invalid' });
      return;
    }
    setState({ kind: 'checking' });
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      void fetchLookup(market, trimmed, ctl.signal)
        .then((next) => {
          if (!ctl.signal.aborted) setState(next);
        })
        .catch((err: unknown) => {
          if (ctl.signal.aborted) return;
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        });
    }, DEBOUNCE_MS);

    return (): void => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [market, trimmed]);

  return state;
}

export function LookupStatus({
  lookup,
}: {
  readonly lookup: LookupState;
}): React.ReactElement | null {
  if (lookup.kind === 'idle') return null;
  if (lookup.kind === 'checking') {
    return (
      <Text mt="4px" fontSize="11px" color="term.ink3">
        looking up…
      </Text>
    );
  }
  if (lookup.kind === 'found') {
    return (
      <Text mt="4px" fontSize="11px" color="term.green">
        ✓ {lookup.stock.code} · {lookup.stock.name}
      </Text>
    );
  }
  return <ErrorLine lookup={lookup} />;
}

function ErrorLine({ lookup }: { readonly lookup: LookupState }): React.ReactElement | null {
  const message =
    lookup.kind === 'invalid'
      ? 'code format does not match market'
      : lookup.kind === 'missing'
        ? 'not found in universe (hk/us: refresh universe first)'
        : lookup.kind === 'error'
          ? lookup.message
          : null;
  if (message === null) return null;
  return (
    <Text mt="4px" fontSize="11px" color="term.red">
      {message}
    </Text>
  );
}
