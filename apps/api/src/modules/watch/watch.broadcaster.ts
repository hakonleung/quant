/**
 * Periodically pushes the current watch task list onto the realtime
 * socket bus (`watch.snapshot` topic). Replaces the legacy
 * `GET /api/watch/stream` SSE endpoint — the FE now subscribes via
 * Socket.IO and receives the same payload at the same 1Hz cadence.
 *
 * Lifecycle:
 *   - `onModuleInit` arms `setInterval`; `onModuleDestroy` clears it.
 *   - The bus drops emits that arrive before the gateway has set its
 *     sink (see `SocketBus.emit`), so booting a few seconds before the
 *     first frame is harmless.
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { SocketBus } from '../socket/socket-bus.service.js';
import { WatchService } from './watch.service.js';

const TICK_MS = 1_000;

@Injectable()
export class WatchBroadcaster implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatchBroadcaster.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(WatchService) private readonly service: WatchService,
    @Inject(SocketBus) private readonly bus: SocketBus,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      try {
        this.bus.emit('watch.snapshot', [...this.service.list()]);
      } catch (err) {
        this.logger.warn(`watch_broadcast_failed err=${String(err)}`);
      }
    }, TICK_MS);
    this.logger.log(`watch broadcaster armed — tick=${String(TICK_MS)}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
