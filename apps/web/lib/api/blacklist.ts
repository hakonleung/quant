import { BlacklistSnapshotSchema, type BlacklistSnapshot } from '@quant/shared';

import { apiGet } from './client.js';

export async function fetchBlacklist(): Promise<BlacklistSnapshot> {
  return apiGet('/api/blacklist', (r) => BlacklistSnapshotSchema.parse(r));
}
