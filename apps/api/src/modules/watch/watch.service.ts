/**
 * CRUD + universe orchestration for Watch (`docs/modules/W-0-watch.md` §10).
 *
 * The scheduler talks to the same store directly (no service-layer call
 * needed) — this service is the controller's view.
 */

import { Inject, Injectable } from '@nestjs/common';
import { newTraceId, QuantError, type StockBasic, type WatchTask } from '@quant/shared';
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
      hitCount: 0,
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
}
