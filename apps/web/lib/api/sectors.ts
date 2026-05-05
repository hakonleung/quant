import { SectorSchema, type Sector } from '@quant/shared';
import { z } from 'zod';

import { apiGet, apiPut } from './client.js';

const ListResponseSchema = z.object({ sectors: z.array(SectorSchema) });

export async function fetchSectors(): Promise<readonly Sector[]> {
  const out = await apiGet('/api/sectors', (r) => ListResponseSchema.parse(r));
  return out.sectors;
}

export async function putSectors(sectors: readonly Sector[]): Promise<readonly Sector[]> {
  const out = await apiPut(
    '/api/sectors',
    { sectors },
    (r) => ListResponseSchema.parse(r),
  );
  return out.sectors;
}
