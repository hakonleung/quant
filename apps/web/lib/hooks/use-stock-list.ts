'use client';

import { StockMetaDtoSchema, type StockMetaDto } from '@quant/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { apiGet } from '../api/client.js';

/**
 * The full list (~5500 rows × 8 nested quarterlies) is already validated
 * server-side at the Arrow boundary in
 * `apps/api/src/modules/stock-meta/domain/arrow-mapper.ts`. Re-running
 * `z.array(StockMetaDtoSchema).parse(raw)` on the browser used to cost
 * ~50 k zod object parses on first paint. We trust the API contract and
 * keep a single 1-sample "contract fuse": if the server ever ships an
 * incompatible shape, the fuse blows on first row instead of silently
 * letting bad data through.
 */
function isStockMetaList(raw: unknown): raw is readonly StockMetaDto[] {
  if (!Array.isArray(raw)) return false;
  if (raw.length === 0) return true;
  // Throws on shape mismatch — that's how we want the boot to fail loudly.
  StockMetaDtoSchema.parse(raw[0]);
  return true;
}

function parseStockList(raw: unknown): readonly StockMetaDto[] {
  if (!isStockMetaList(raw)) {
    throw new Error('stock-list: response is not an array of StockMetaDto');
  }
  return raw;
}

async function fetchAll(): Promise<readonly StockMetaDto[]> {
  // Degrade gracefully when the Python Flight server is offline so the
  // workbench still loads (UI shows an empty universe placeholder).
  try {
    return await apiGet('/api/stocks', parseStockList);
  } catch {
    return [];
  }
}

export function useStockList(): UseQueryResult<readonly StockMetaDto[]> {
  return useQuery({
    queryKey: ['stock-list'],
    queryFn: fetchAll,
    staleTime: 60 * 60 * 1000,
  });
}
