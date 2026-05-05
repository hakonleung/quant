/**
 * File-backed sectors store. Replace-on-write semantics mirror the
 * frontend's prior IndexedDB persist behavior: the client owns the full
 * list and PUTs it whole. Atomicity comes from `tmp + rename`; a single
 * mutex serialises read/write.
 */

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SectorsListSchema, type Sector } from '@quant/shared';
import { atomicWriteJson, readJsonOr } from '../watch/domain/atomic-json.js';

export const SECTORS_DATA_DIR = Symbol('SECTORS_DATA_DIR');

@Injectable()
export class SectorsStore implements OnModuleInit {
  private readonly logger = new Logger(SectorsStore.name);
  private sectors: readonly Sector[] = [];
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(@Inject(SECTORS_DATA_DIR) private readonly dataDir: string) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  private get file(): string {
    return `${this.dataDir}/sectors.json`;
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
      const raw = await readJsonOr<unknown>(this.file, []);
      const parsed = SectorsListSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn(`sectors.json failed validation, starting empty: ${parsed.error.message}`);
        this.loaded = true;
        return;
      }
      this.sectors = parsed.data;
      this.loaded = true;
      this.logger.log(`loaded ${String(this.sectors.length)} sectors`);
    });
  }

  list(): readonly Sector[] {
    return this.sectors;
  }

  async replace(sectors: readonly Sector[]): Promise<readonly Sector[]> {
    return this.withLock(async () => {
      this.sectors = [...sectors];
      await atomicWriteJson(this.file, this.sectors);
      return this.sectors;
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}
