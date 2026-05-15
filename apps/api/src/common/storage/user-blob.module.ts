/**
 * Global module exposing the singleton `UserBlobStore` — the per-user
 * `data/users/{userId}/user.parquet` that consolidates watch / ledger /
 * sysCfg state.
 *
 * Marked `@Global()` because it's a foundational store used by 4
 * different feature modules (watch, ledger, sys-cfg, plus the
 * cross-cutting migrator script). Importing it everywhere would
 * otherwise be busywork.
 */

import { Global, Logger, Module } from '@nestjs/common';

import { AUTH_CONFIG, type AuthConfigShape } from '../../modules/auth/config/auth.config.js';
import { UserBlobStore } from './user-blob.store.js';

@Global()
@Module({
  providers: [
    {
      provide: UserBlobStore,
      inject: [AUTH_CONFIG],
      useFactory: (cfg: AuthConfigShape): UserBlobStore => {
        const logger = new Logger(UserBlobStore.name);
        return new UserBlobStore({
          dataRoot: cfg.dataRoot,
          logger: { warn: (m) => logger.warn(m), log: (m) => logger.log(m) },
        });
      },
    },
  ],
  exports: [UserBlobStore],
})
export class UserBlobModule {}
