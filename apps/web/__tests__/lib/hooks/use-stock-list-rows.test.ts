/**
 * Smoke test for `useStockListRows` — confirms it composes the request
 * shape correctly, gates on `enabled`, and surfaces the BE response
 * verbatim. The actual fetch is mocked so the test stays hermetic.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StockListRowsRequest, StockListRowsResponse } from '@quant/shared';

import { useStockListRows } from '../../../lib/hooks/use-stock-list-rows.js';

const calls: StockListRowsRequest[] = [];

vi.mock('../../../lib/api/endpoints.js', () => ({
  postStockListRows: async (body: StockListRowsRequest): Promise<StockListRowsResponse> => {
    calls.push(body);
    return {
      kind: body.kind,
      columns: body.columns ?? ['name', 'price', 'chgPct', 'turnoverRate', 'turnover', 'consecUp'],
      sort: body.sort ?? { key: 'chgPct', dir: 'desc' },
      rows: body.codes.map((code) => ({
        code,
        name: `name-${code}`,
        price: 1,
        chgPct: 0,
        turnoverRate: null,
        turnover: null,
        consecUp: null,
        ret5d: null,
        ret10d: null,
        ret20d: null,
        ret90d: null,
        ret250d: null,
        mktCap: null,
        floatMktCap: null,
        peTtm: null,
        peDynamic: null,
        pb: null,
        peg: null,
        grossMargin: null,
      })),
    };
  },
}));

afterEach(() => {
  calls.length = 0;
});

function wrapper(): React.FC<{ children: React.ReactNode }> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }) => React.createElement(QueryClientProvider, { client }, children);
}

describe('useStockListRows', () => {
  it('fetches once when codes are non-empty and surfaces the response', async () => {
    const { result } = renderHook(
      () => useStockListRows({ kind: 'watch', codes: ['600519', '000001'] }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'watch', codes: ['600519', '000001'] });
    expect(result.current.data?.rows).toHaveLength(2);
    expect(result.current.data?.kind).toBe('watch');
  });

  it('is disabled by default when codes are empty (no fetch issued)', () => {
    renderHook(() => useStockListRows({ kind: 'screen', codes: [] }), {
      wrapper: wrapper(),
    });
    expect(calls).toHaveLength(0);
  });

  it('honors explicit enabled override', async () => {
    const { result } = renderHook(
      () => useStockListRows({ kind: 'screen', codes: [], enabled: true }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls).toHaveLength(1);
  });

  it('forwards columns + sort overrides', async () => {
    const { result } = renderHook(
      () =>
        useStockListRows({
          kind: 'dynamic-sector',
          codes: ['600519'],
          columns: ['name', 'mktCap'],
          sort: { key: 'mktCap', dir: 'asc' },
        }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]).toMatchObject({
      columns: ['name', 'mktCap'],
      sort: { key: 'mktCap', dir: 'asc' },
    });
  });
});
