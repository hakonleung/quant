/**
 * CRUD + universe orchestration for Watch (`docs/modules/W-0-watch.md` §10).
 *
 * The scheduler talks to the same store directly (no service-layer call
 * needed) — this service is the controller's view.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  newTraceId,
  QuantError,
  type StockBasic,
  type WatchMarket,
  type WatchTask,
} from '@quant/shared';
import { StockMetaService } from '../stock-meta/stock-meta.service.js';
import type { WatchTaskCreate, WatchTaskPatch } from './dto/watch.dto.js';
import { WatchTaskStore } from './watch-task.store.js';
import { WatchUniverseStore } from './watch-universe.store.js';
import { WATCH_QUOTE_PORT, type WatchQuotePort } from './domain/watch-port.js';

@Injectable()
export class WatchService {
  constructor(
    @Inject(WatchTaskStore) private readonly tasks: WatchTaskStore,
    @Inject(WatchUniverseStore) private readonly universe: WatchUniverseStore,
    @Inject(WATCH_QUOTE_PORT) private readonly port: WatchQuotePort,
    @Inject(StockMetaService) private readonly stockMeta: StockMetaService,
  ) {}

  list(): readonly WatchTask[] {
    return this.tasks.list();
  }

  async create(payload: WatchTaskCreate): Promise<WatchTask> {
    const existing = this.tasks.get(payload.market, payload.code);
    if (existing !== undefined) {
      throw new QuantError(
        'WATCH_TASK_CONFLICT',
        `task already exists for ${payload.market}:${payload.code}`,
        { market: payload.market, code: payload.code },
      );
    }
    const now = new Date().toISOString();
    const task: WatchTask = {
      market: payload.market,
      code: payload.code,
      name: payload.name,
      conditions: payload.conditions,
      intervalSec: payload.intervalSec,
      pushIntervalSec: payload.pushIntervalSec,
      remaining: payload.remaining,
      notifySlack: payload.notifySlack,
      enabled: payload.enabled,
      createdAt: now,
      lastTickAt: null,
      lastPushAt: null,
      lastSampleAt: null,
      lastMatchAt: null,
      hitCount: 0,
      lastSamplePrice: null,
    };
    await this.tasks.upsert(task, false);
    return task;
  }

  async patch(
    market: WatchTask['market'],
    code: string,
    payload: WatchTaskPatch,
  ): Promise<WatchTask> {
    const next = await this.tasks.patch(market, code, (current) => ({
      ...current,
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.conditions !== undefined ? { conditions: payload.conditions } : {}),
      ...(payload.intervalSec !== undefined ? { intervalSec: payload.intervalSec } : {}),
      ...(payload.pushIntervalSec !== undefined
        ? { pushIntervalSec: payload.pushIntervalSec }
        : {}),
      ...(payload.remaining !== undefined ? { remaining: payload.remaining } : {}),
      ...(payload.notifySlack !== undefined ? { notifySlack: payload.notifySlack } : {}),
      ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
    }));
    if (next === undefined) {
      throw new QuantError('NOT_FOUND', `watch task ${market}:${code} not found`, {
        market,
        code,
      });
    }
    return next;
  }

  async delete(market: WatchTask['market'], code: string): Promise<void> {
    const ok = await this.tasks.delete(market, code);
    if (!ok) {
      throw new QuantError('NOT_FOUND', `watch task ${market}:${code} not found`, {
        market,
        code,
      });
    }
  }

  async getUniverse(market: 'hk' | 'us'): Promise<readonly StockBasic[]> {
    return this.universe.load(market);
  }

  async refreshUniverse(market: 'hk' | 'us'): Promise<readonly StockBasic[]> {
    const traceId = newTraceId();
    const rows = await this.port.refreshUniverse(market, traceId);
    await this.universe.replace(market, rows);
    return rows;
  }

  /**
   * Resolve `(market, code)` to a `StockBasic` so the frontend can
   * confirm a ticker exists before posting a task. Throws
   * `WATCH_CODE_NOT_FOUND` (404) when the code is absent from the
   * source of truth for that market — A-share via stock-meta,
   * HK/US via the on-disk universe cache.
   */
  async lookup(market: WatchMarket, code: string): Promise<StockBasic> {
    if (market === 'a') return this.lookupA(code);
    return this.lookupHkUs(market, code);
  }

  private async lookupA(code: string): Promise<StockBasic> {
    const traceId = newTraceId();
    try {
      const meta = await this.stockMeta.get(code, traceId);
      return { market: 'a', code: meta.code, name: meta.name };
    } catch (err) {
      if (err instanceof QuantError && err.code === 'STOCK_NOT_FOUND') {
        throw new QuantError('WATCH_CODE_NOT_FOUND', `a-share code ${code} not found`, {
          market: 'a',
          code,
        });
      }
      throw err;
    }
  }

  private async lookupHkUs(market: 'hk' | 'us', code: string): Promise<StockBasic> {
    const rows = await this.universe.load(market);
    const hit = rows.find((r) => r.code === code);
    if (hit !== undefined) return hit;
    throw new QuantError(
      'WATCH_CODE_NOT_FOUND',
      `${market}-code ${code} not in cached universe; try POST /api/watch/universe/refresh`,
      { market, code },
    );
  }
}
