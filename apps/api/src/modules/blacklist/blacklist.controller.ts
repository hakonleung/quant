import { Controller, Get, Inject } from '@nestjs/common';
import type { BlacklistSnapshot } from '@quant/shared';

import { BlacklistStore } from './blacklist.store.js';

@Controller('blacklist')
export class BlacklistController {
  constructor(@Inject(BlacklistStore) private readonly store: BlacklistStore) {}

  /**
   * `GET /api/blacklist` — current cron-computed A-share noise list.
   * Read-only; the daily cron is the only writer.
   */
  @Get()
  get(): BlacklistSnapshot {
    return this.store.snapshot();
  }
}
