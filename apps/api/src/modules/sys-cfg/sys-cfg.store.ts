/**
 * Per-user system-config store. Each user gets one
 * `data/users/{userId}/sys-cfg/sys-cfg.json` blob (theme, slack
 * targets, applied columns); the FE replaces the blob on every
 * mutation, so the wire format and the on-disk file stay trivially
 * atomic.
 *
 * No legacy migration: a `sys-cfg.json` that fails the strict schema
 * (e.g. carrying the old `blacklist` field) is rejected on load and
 * `DEFAULT_SYS_CFG` is used instead — the user re-saves once from the
 * UI and the file is rewritten in the new shape.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { DEFAULT_SYS_CFG, SysCfgSchema, type SysCfg } from '@quant/shared';

import { UserScopedJsonStore } from '../../common/user-scoped-store.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';

@Injectable()
export class SysCfgStore {
  private readonly logger = new Logger(SysCfgStore.name);
  private readonly inner: UserScopedJsonStore<SysCfg>;

  constructor(@Inject(AUTH_CONFIG) cfg: AuthConfigShape) {
    this.inner = new UserScopedJsonStore<SysCfg>(cfg.dataRoot, {
      relativePath: (uid) => `users/${uid}/sys-cfg/sys-cfg.json`,
      schema: SysCfgSchema,
      fallback: () => DEFAULT_SYS_CFG,
      logger: this.logger,
    });
  }

  async get(userId: string): Promise<SysCfg> {
    return this.inner.snapshot(userId);
  }

  async replace(userId: string, cfg: SysCfg): Promise<SysCfg> {
    return this.inner.replace(userId, cfg);
  }
}
