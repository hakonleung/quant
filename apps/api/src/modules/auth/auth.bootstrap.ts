/**
 * Boot-time helpers for the auth module — kept as an `@Injectable()`
 * provider (rather than running from `AuthModule.onModuleInit`) because
 * NestJS' module-class constructor DI is unreliable under tsx watch +
 * ESM. Providers get full DI; module classes do not.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { AuthConfig } from './config/auth.config.js';

const LEGACY_MIGRATIONS: ReadonlyArray<{ from: string; to: string }> = [
  { from: '_ledger/entries.json', to: 'users/admin/_ledger/entries.json' },
  { from: '_ledger/ai-cache.json', to: 'users/admin/_ledger/ai-cache.json' },
  { from: 'watch/tasks.json', to: 'users/admin/watch/tasks.json' },
  { from: 'watch/groups.json', to: 'users/admin/watch/groups.json' },
  { from: 'sys-cfg/sys-cfg.json', to: 'users/admin/sys-cfg/sys-cfg.json' },
];

@Injectable()
export class AuthBootstrap implements OnModuleInit {
  private readonly logger = new Logger(AuthBootstrap.name);

  constructor(@Inject(AuthConfig) private readonly cfg: AuthConfig) {}

  /**
   * Defensive boot-time migration: when `AUTH_MODE=disabled` and the
   * legacy single-user layout is still present (no `data/users/admin`),
   * relocate it before any store loads. Idempotent — once
   * `data/users/admin` exists this is a no-op.
   *
   * Runs before stores load because `AuthModule` is registered first in
   * `AppModule.imports` (see `apps/api/src/app.module.ts`); per-module
   * `OnModuleInit` hooks fire in module-load order.
   */
  async onModuleInit(): Promise<void> {
    if (this.cfg.mode !== 'disabled') return;
    await migrateLegacyToAdmin(this.cfg.dataRoot, this.logger);
  }
}

async function migrateLegacyToAdmin(dataRoot: string, logger: Logger): Promise<void> {
  const adminDir = path.join(dataRoot, 'users', 'admin');
  if (await pathExists(adminDir)) return;
  let moved = 0;
  for (const m of LEGACY_MIGRATIONS) {
    const src = path.join(dataRoot, m.from);
    const dst = path.join(dataRoot, m.to);
    if (!(await pathExists(src))) continue;
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    moved += 1;
  }
  if (moved > 0) {
    logger.log(`migrated ${String(moved)} legacy single-user files into data/users/admin`);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}
