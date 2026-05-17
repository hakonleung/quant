/**
 * Periodically pushes each user's watch task list onto the realtime
 * socket bus (`watch.snapshot` topic, scoped to `user:{userId}` rooms).
 *
 * Lifecycle:
 *   - `onModuleInit` arms `setInterval`; `onModuleDestroy` clears it.
 *   - The bus drops emits that arrive before the gateway has set its
 *     sink (boot ordering), so the next tick lands fine.
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ServerConfigCenter } from '@quant/config/server';

import { UserStore } from '../auth/user.store.js';
import { SocketBus } from '../socket/socket-bus.service.js';
import { WatchService } from './watch.service.js';

@Injectable()
export class WatchBroadcaster implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatchBroadcaster.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(WatchService) private readonly service: WatchService,
    @Inject(SocketBus) private readonly bus: SocketBus,
    @Inject(UserStore) private readonly users: UserStore,
  ) {}

  onModuleInit(): void {
    const tickMs = ServerConfigCenter.get().watch.broadcasterTickMs;
    this.timer = setInterval(() => {
      void this.broadcast();
    }, tickMs);
    this.logger.log(`watch broadcaster armed — tick=${String(tickMs)}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async broadcast(): Promise<void> {
    for (const user of this.users.list()) {
      try {
        const tasks = await this.service.list(user.id);
        this.bus.emitTo(user.id, 'watch.snapshot', [...tasks]);
      } catch (err) {
        this.logger.warn(`watch_broadcast_failed user=${user.id} err=${String(err)}`);
      }
    }
  }
}
