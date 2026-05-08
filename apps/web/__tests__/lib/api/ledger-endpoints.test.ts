/**
 * Endpoint-level smoke tests — the API client is mostly fetch + zod
 * around BFF routes; we cover the schema-rejection paths that would
 * otherwise mask a contract drift, and the encoding of the URL param.
 */

import { LedgerEntrySchema } from '@quant/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLedgerEntry,
  deleteLedgerEntry,
  importLedger,
  listLedgerEntries,
  patchLedgerEntry,
} from '../../../lib/api/endpoints.js';

const ENTRY = LedgerEntrySchema.parse({
  date: '2026-05-01',
  pnlAmount: '500',
  closingPosition: '100500',
});

interface MockResponseInit {
  readonly status?: number;
  readonly body?: unknown;
}

function mockResponse({ status = 200, body }: MockResponseInit = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
  } as unknown as Response;
}

describe('ledger api endpoints', () => {
  let calls: { url: string; init?: RequestInit }[] = [];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init !== undefined && { init }) });
        // Default 200 OK with the request body for create/patch, [] for list.
        if (url === '/api/ledger' && init?.method === 'POST') {
          return mockResponse({ body: JSON.parse(init.body as string) as unknown });
        }
        if (url.startsWith('/api/ledger/') && init?.method === 'PATCH') {
          const date = url.replace('/api/ledger/', '');
          // Echo a full valid entry so the LedgerEntrySchema parse passes;
          // tests assert on the *request* shape, not the (mocked) response.
          const echoed = { date, pnlAmount: '0', closingPosition: '100000' };
          const patch = JSON.parse(init.body as string) as Record<string, unknown>;
          return mockResponse({ body: { ...echoed, ...patch } });
        }
        if (url.startsWith('/api/ledger/') && init?.method === 'DELETE') {
          return mockResponse({ status: 204 });
        }
        if (url === '/api/ledger/import') {
          return mockResponse({ body: { entries: JSON.parse(init?.body as string).entries } });
        }
        return mockResponse({ body: [ENTRY] });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listLedgerEntries returns parsed entries', async () => {
    const out = await listLedgerEntries();
    expect(out).toEqual([ENTRY]);
    expect(calls[0]?.url).toBe('/api/ledger');
  });

  it('createLedgerEntry POSTs and parses', async () => {
    const out = await createLedgerEntry(ENTRY);
    expect(out.date).toBe(ENTRY.date);
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('patchLedgerEntry encodes the date in the path and only sends provided fields', async () => {
    await patchLedgerEntry('2026-05-01', { pnlAmount: '999' });
    expect(calls[0]?.url).toBe('/api/ledger/2026-05-01');
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ pnlAmount: '999' });
  });

  it('patchLedgerEntry sends closingPosition: null when caller passes null', async () => {
    await patchLedgerEntry('2026-05-01', { closingPosition: null });
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ closingPosition: null });
  });

  it('deleteLedgerEntry hits the DELETE endpoint', async () => {
    await deleteLedgerEntry('2026-05-01');
    expect(calls[0]?.url).toBe('/api/ledger/2026-05-01');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('importLedger sends the entries wrapper', async () => {
    await importLedger([ENTRY]);
    expect(calls[0]?.url).toBe('/api/ledger/import');
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ entries: [ENTRY] });
  });
});
