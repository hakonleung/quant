import { SysCfgSchema, type SysCfg } from '@quant/shared';

import { apiGet, apiPut } from './client.js';

export async function fetchSysCfg(): Promise<SysCfg> {
  return apiGet('/api/sys-cfg', (r) => SysCfgSchema.parse(r));
}

export async function putSysCfg(cfg: SysCfg): Promise<SysCfg> {
  return apiPut('/api/sys-cfg', cfg, (r) => SysCfgSchema.parse(r));
}
