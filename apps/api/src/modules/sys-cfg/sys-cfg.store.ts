/**
 * Per-user system-config facade. Delegates to `UserBlobStore` (single
 * `data/users/{uid}/user.parquet`); the legacy
 * `data/users/{uid}/sys-cfg/sys-cfg.json` is adopted by the blob
 * store's lazy migrator on first access.
 *
 * Public API mirrors the previous implementation (`get`, `replace`) so
 * `SysCfgController` is untouched.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { SysCfg } from '@quant/shared';

import { UserBlobStore } from '../../common/storage/user-blob.store.js';

@Injectable()
export class SysCfgStore {
  constructor(@Inject(UserBlobStore) private readonly blob: UserBlobStore) {}

  async get(userId: string): Promise<SysCfg> {
    const b = await this.blob.read(userId);
    return b.sysCfg;
  }

  async replace(userId: string, cfg: SysCfg): Promise<SysCfg> {
    const next = await this.blob.update(userId, (b) => ({ ...b, sysCfg: cfg }));
    return next.sysCfg;
  }
}
