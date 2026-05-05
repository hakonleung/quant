/**
 * `POST /api/push/test` — send a one-off Slack message via the same
 * webhook adapter Watch uses. Returns `dryRun: true` when no webhook
 * is configured (the adapter only logs in that case) so the UI can
 * surface the difference between "delivered" and "logged-only".
 */

import { Body, Controller, Headers, Inject, Post } from '@nestjs/common';
import { PushTestRequestSchema, type PushTestRequest, type PushTestResponse } from '@quant/shared';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { WATCH_NOTIFIER, type WatchNotifier } from '../watch/watch-notifier.js';

const pipe = new ZodValidationPipe(PushTestRequestSchema);

@Controller('push')
export class PushController {
  constructor(@Inject(WATCH_NOTIFIER) private readonly notifier: WatchNotifier) {}

  @Post('test')
  async test(
    @Body(pipe) body: PushTestRequest,
    @Headers('x-trace-id') traceId: string | undefined,
  ): Promise<PushTestResponse> {
    const dryRun =
      (process.env['QUANT_WATCH_SLACK_WEBHOOK'] ?? process.env['SLACK_WEBHOOK_URL'] ?? null) ===
      null;
    const channel = body.channel ?? '#quant-signals';
    const lines = [`▶ ${channel}`, body.payload];
    if (body.note !== undefined && body.note.trim().length > 0) {
      lines.push(`note: ${body.note}`);
    }
    await this.notifier.send(lines.join('\n'), traceId ?? 'push-test');
    return { ok: true, dryRun, deliveredAt: new Date().toISOString() };
  }
}
