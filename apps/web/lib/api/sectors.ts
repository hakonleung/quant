import { SectorSchema, type Sector } from '@quant/shared';
import { z } from 'zod';

import { apiGet, apiPost, apiPut } from './client.js';

const ListResponseSchema = z.object({ sectors: z.array(SectorSchema) });
const RefreshResponseSchema = z.object({ sector: SectorSchema });

export async function fetchSectors(): Promise<readonly Sector[]> {
  const out = await apiGet('/api/sectors', (r) => ListResponseSchema.parse(r));
  return out.sectors;
}

export async function putSectors(sectors: readonly Sector[]): Promise<readonly Sector[]> {
  const out = await apiPut('/api/sectors', { sectors }, (r) => ListResponseSchema.parse(r));
  return out.sectors;
}

export async function refreshSector(id: string): Promise<Sector> {
  const out = await apiPost(`/api/sectors/${encodeURIComponent(id)}/refresh`, {}, (r) =>
    RefreshResponseSchema.parse(r),
  );
  return out.sector;
}

export async function publishSector(id: string, published: boolean): Promise<Sector> {
  const out = await apiPost(`/api/sectors/${encodeURIComponent(id)}/publish`, { published }, (r) =>
    RefreshResponseSchema.parse(r),
  );
  return out.sector;
}
