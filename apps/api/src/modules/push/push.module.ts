/**
 * SYS.PUSH module — exposes a single `POST /api/push/test` endpoint that
 * fires a one-shot Slack-webhook message. Reuses the same adapter the
 * Watch scheduler uses so dev-mode dry-log behavior is identical.
 */

import { Module } from '@nestjs/common';

import {
  SlackWebhookWatchNotifier,
  WATCH_NOTIFIER,
  type WatchNotifier,
} from '../watch/watch-notifier.js';
import { PushController } from './push.controller.js';

@Module({
  controllers: [PushController],
  providers: [
    {
      provide: WATCH_NOTIFIER,
      useFactory: (): WatchNotifier => {
        const url =
          process.env['QUANT_WATCH_SLACK_WEBHOOK'] ?? process.env['SLACK_WEBHOOK_URL'] ?? null;
        return new SlackWebhookWatchNotifier(url);
      },
    },
  ],
})
export class PushModule {}
