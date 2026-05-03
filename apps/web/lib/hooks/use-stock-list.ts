'use client';

import { StockMetaDtoSchema, type StockMetaDto } from '@quant/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';

import { apiGet } from '../api/client.js';

const ListSchema = z.array(StockMetaDtoSchema);

async function fetchAll(): Promise<readonly StockMetaDto[]> {
  // Degrade gracefully when the Python Flight server is offline so the
  // workbench still loads (UI shows an empty universe placeholder).
  try {
    return await apiGet('/api/stocks', (raw) => ListSchema.parse(raw));
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
