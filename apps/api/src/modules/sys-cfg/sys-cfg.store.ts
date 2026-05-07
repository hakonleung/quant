/**
 * File-backed system-config store. The frontend treats Sys.Cfg as a
 * single blob (theme + slack targets + applied columns + blacklist) and
 * replaces it on every mutation; that mirror keeps the wire format and
 * the on-disk file trivially atomic.
 */

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DEFAULT_SYS_CFG, SysCfgSchema, type SysCfg } from '@quant/shared';
import { atomicWriteJson, readJsonOr } from '../watch/domain/atomic-json.js';

export const SYS_CFG_DATA_DIR = Symbol('SYS_CFG_DATA_DIR');

@Injectable()
export class SysCfgStore implements OnModuleInit {
  private readonly logger = new Logger(SysCfgStore.name);
  private cfg: SysCfg = DEFAULT_SYS_CFG;
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(@Inject(SYS_CFG_DATA_DIR) private readonly dataDir: string) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  private get file(): string {
    return `${this.dataDir}/sys-cfg.json`;
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
      const raw = await readJsonOr<unknown>(this.file, DEFAULT_SYS_CFG);
      // Pre-zod migration: drop the legacy `blacklist` field (the
      // user-maintained list moved to a backend-cron-managed file in
      // 2026-05). Strict schema would otherwise reject loaded files.
      const cleaned =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          ? (() => {
              const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
              delete r['blacklist'];
              return r;
            })()
          : raw;
      const parsed = SysCfgSchema.safeParse(cleaned);
      if (!parsed.success) {
        this.logger.warn(`sys-cfg.json failed validation, using defaults: ${parsed.error.message}`);
        this.cfg = DEFAULT_SYS_CFG;
        this.loaded = true;
        return;
      }
      this.cfg = parsed.data;
      this.loaded = true;
      this.logger.log('loaded sys-cfg');
    });
  }

  get(): SysCfg {
    return this.cfg;
  }

  async replace(cfg: SysCfg): Promise<SysCfg> {
    return this.withLock(async () => {
      this.cfg = cfg;
      await atomicWriteJson(this.file, this.cfg);
      return this.cfg;
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}
