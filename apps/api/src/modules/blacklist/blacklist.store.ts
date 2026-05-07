/**
 * File-backed cache of the daily-computed A-share blacklist.
 *
 * The cron orchestrator's `blacklist` scan kind invokes the Python
 * `compute_ashare_blacklist` Flight op and writes the result through
 * {@link BlacklistStore.replace}. Workers + the controller read via
 * {@link BlacklistStore.snapshot} (synchronous after `load`).
 *
 * On cold start the file may not exist yet (first ever boot, or `data/`
 * blown away) — `load` defaults to {@link EMPTY_BLACKLIST.codes} so
 * meta / kline workers proceed unfiltered until the next cron tick.
 */

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { BlacklistSnapshotSchema, EMPTY_BLACKLIST, type BlacklistSnapshot } from '@quant/shared';

import { atomicWriteJson, readJsonOr } from '../watch/domain/atomic-json.js';
import { BLACKLIST_DATA_DIR } from './blacklist.token.js';

@Injectable()
export class BlacklistStore implements OnModuleInit {
  private readonly logger = new Logger(BlacklistStore.name);
  private snap: BlacklistSnapshot = EMPTY_BLACKLIST;
  private codeSet: ReadonlySet<string> = new Set();
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(@Inject(BLACKLIST_DATA_DIR) private readonly dataDir: string) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  private get file(): string {
    return `${this.dataDir}/blacklist.json`;
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
      const raw = await readJsonOr<unknown>(this.file, EMPTY_BLACKLIST);
      const parsed = BlacklistSnapshotSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn(
          `blacklist.json failed validation, starting empty: ${parsed.error.message}`,
        );
        this.snap = EMPTY_BLACKLIST;
        this.codeSet = new Set();
      } else {
        this.snap = parsed.data;
        this.codeSet = new Set(parsed.data.codes);
      }
      this.loaded = true;
      this.logger.log(`loaded blacklist size=${String(this.codeSet.size)}`);
    });
  }

  snapshot(): BlacklistSnapshot {
    return this.snap;
  }

  has(code: string): boolean {
    return this.codeSet.has(code);
  }

  async replace(snap: BlacklistSnapshot): Promise<BlacklistSnapshot> {
    return this.withLock(async () => {
      this.snap = snap;
      this.codeSet = new Set(snap.codes);
      await atomicWriteJson(this.file, this.snap);
      return this.snap;
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}
