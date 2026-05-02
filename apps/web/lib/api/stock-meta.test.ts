import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuantError, TRACE_HEADER } from '@quant/shared';
import { fetchStockMeta, fetchStockMetaBatch, fetchStockMetaByIndustry } from './stock-meta.js';

const SAMPLE = {
  code: '600519.SH',
  name: '贵州茅台',
  name_pinyin: 'GZMT',
  exchange: 'SH',
  board: 'MAIN',
  industry_sw_l1: '食品饮料',
  industry_sw_l2: '白酒',
  industry_sw_l3: '高端白酒',
  list_date: '2001-08-27',
  delist_date: null,
  total_share: '1256197800',
  float_share: '1256197800',
  status: 'NORMAL',
  updated_at: '2026-05-01T00:00:00+00:00',
};

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchStockMeta helpers', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const opts = { baseUrl: 'http://api', traceId: 'tid' };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /api/stocks/:code with the trace_id header and parses the body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SAMPLE));
    const dto = await fetchStockMeta('600519.SH', opts);
    expect(dto.code).toBe('600519.SH');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api/api/stocks/600519.SH');
    expect((init?.headers as Record<string, string>)[TRACE_HEADER]).toBe('tid');
  });

  it('encodes special characters in the path segment', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SAMPLE));
    await fetchStockMeta('weird/code', opts);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api/api/stocks/weird%2Fcode');
  });

  it('throws StockMetaDtoSchema validation when the body drifts', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...SAMPLE, list_date: 'nope' }));
    await expect(fetchStockMeta('x', opts)).rejects.toThrow();
  });

  it('translates a 404 error envelope into QuantError(STOCK_NOT_FOUND)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: 'STOCK_NOT_FOUND',
          message: 'no such stock: 999',
          trace_id: 'tid',
          details: { code: '999' },
        },
        { status: 404 },
      ),
    );
    let caught: unknown = null;
    try {
      await fetchStockMeta('999', opts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuantError);
    expect((caught as QuantError).code).toBe('STOCK_NOT_FOUND');
  });

  it('falls back to QuantError(INTERNAL) when the error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('boom', { status: 503, headers: { 'content-type': 'text/plain' } }),
    );
    let caught: unknown = null;
    try {
      await fetchStockMeta('x', opts);
    } catch (err) {
      caught = err;
    }
    expect((caught as QuantError).code).toBe('INTERNAL');
  });

  it('falls back to QuantError(INTERNAL) when the error envelope has an unknown code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { code: 'NOT_AN_ERROR_CODE', message: 'm', trace_id: 't', details: {} },
        { status: 500 },
      ),
    );
    let caught: unknown = null;
    try {
      await fetchStockMeta('x', opts);
    } catch (err) {
      caught = err;
    }
    expect((caught as QuantError).code).toBe('INTERNAL');
  });

  it('fetchStockMetaBatch short-circuits on empty input without calling fetch', async () => {
    await expect(fetchStockMetaBatch([], opts)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetchStockMetaBatch issues GET /api/stocks/batch with comma-joined codes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([SAMPLE]));
    await fetchStockMetaBatch(['600519.SH', '000858.SZ'], opts);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://api/api/stocks/batch?codes=600519.SH,000858.SZ',
    );
  });

  it('fetchStockMetaByIndustry issues GET /api/stocks/by-industry?sw_l2=...', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([SAMPLE]));
    await fetchStockMetaByIndustry('白酒', opts);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `http://api/api/stocks/by-industry?sw_l2=${encodeURIComponent('白酒')}`,
    );
  });

  it('forwards revalidateSeconds as Next.js fetch hint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SAMPLE));
    await fetchStockMeta('600519.SH', { ...opts, revalidateSeconds: 60 });
    const init = fetchMock.mock.calls[0]![1] as { next?: { revalidate: number } };
    expect(init.next).toEqual({ revalidate: 60 });
  });
});
