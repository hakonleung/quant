/**
 * Slack-webhook notifier for Watch alerts (`docs/modules/W-0-watch.md` §9).
 *
 * v0 wires NestJS directly to a Slack incoming webhook. The
 * §08 NotificationService (Python-side) owns the canonical routing /
 * dedupe / audit pipeline; once a Flight ``notify.emit`` op exists this
 * adapter should switch to delegate to it. Until then we keep the per-
 * source dedupe window at zero (per §9 of W-0) and drive throttling
 * entirely from `WatchScheduler.lastPushAt + pushIntervalSec`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

export interface WatchNotifier {
  send(text: string, traceId: string): Promise<void>;
}

export const WATCH_NOTIFIER = Symbol('WATCH_NOTIFIER');

/**
 * Pick up `HTTPS_PROXY` / `HTTP_PROXY` from the environment so dev
 * machines behind a forward proxy (common in CN networks) can reach
 * `hooks.slack.com`. Node's global `fetch` does NOT honor these env
 * vars by default — undici's `ProxyAgent` does.
 */
function buildDispatcher(): Dispatcher | null {
  const proxy = process.env['HTTPS_PROXY'] ?? process.env['HTTP_PROXY'] ?? null;
  if (proxy === null || proxy === '') return null;
  return new ProxyAgent(proxy);
}

@Injectable()
export class SlackWebhookWatchNotifier implements WatchNotifier {
  private readonly logger = new Logger(SlackWebhookWatchNotifier.name);
  private readonly dispatcher: Dispatcher | null = buildDispatcher();

  constructor(private readonly webhookUrl: string | null) {}

  async send(text: string, traceId: string): Promise<void> {
    if (this.webhookUrl === null) {
      // No webhook configured — log the would-be alert so dev can still
      // observe trigger firings in the gateway log.
      this.logger.log(`watch_alert_drylog trace_id=${traceId} ${text}`);
      return;
    }
    try {
      const res = await undiciFetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        ...(this.dispatcher !== null ? { dispatcher: this.dispatcher } : {}),
      });
      if (!res.ok) {
        this.logger.warn(`slack_webhook_non_2xx status=${String(res.status)} trace_id=${traceId}`);
      }
    } catch (err) {
      this.logger.warn(`slack_webhook_failed trace_id=${traceId} err=${String(err)}`);
    }
  }
}
