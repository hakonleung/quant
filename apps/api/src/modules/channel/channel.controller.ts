/**
 * Channel HTTP routes:
 *
 *   POST /api/channel/send         — manual outbound (replaces /api/push/test).
 *   GET  /api/channel/list         — registered channel statuses.
 *   POST /api/channel/feishu/card  — Feishu interactive card callback.
 *       Configure this URL as "Card Request URL" in the Feishu developer
 *       console (Features → Bot → Card Request URL).  The endpoint handles
 *       the one-time challenge verification and then routes button-click
 *       actions through the same inbound pipeline as IM messages.
 */

import { Body, Controller, Get, Headers, Inject, Logger, Post, Req } from '@nestjs/common';
import {
  ChannelOutboundRequestSchema,
  type ChannelOutboundRequest,
  type ChannelOutboundResponse,
  type ChannelStatus,
} from '@quant/shared';
import type { IncomingHttpHeaders } from 'node:http';

import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { ChannelRegistry } from './channel.registry.js';
import { ChannelService } from './channel.service.js';

const sendPipe = new ZodValidationPipe(ChannelOutboundRequestSchema);

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

@Controller('channel')
export class ChannelController {
  private readonly logger = new Logger(ChannelController.name);

  constructor(
    @Inject(ChannelService) private readonly service: ChannelService,
    @Inject(ChannelRegistry) private readonly registry: ChannelRegistry,
  ) {}

  @Get('list')
  list(): readonly ChannelStatus[] {
    return this.registry.status();
  }

  @Post('send')
  async send(
    @Body(sendPipe) body: ChannelOutboundRequest,
    @Headers('x-trace-id') traceId: string | undefined,
  ): Promise<ChannelOutboundResponse> {
    return this.service.broadcast(body, {
      traceId: traceId ?? `manual-${String(Date.now())}`,
      source: 'manual',
    });
  }

  /**
   * Feishu card action callback (Card Request URL).
   *
   * The adapter normalizes every variant — schema 1.0 / 2.0, encrypted or
   * plain, URL-verification challenges, and signed/unsigned bodies.  This
   * controller is just glue: it forwards the headers (needed for SHA-1 /
   * SHA-256 signature checks) and echoes the right thing back to Feishu
   * within the 3-second deadline.
   *
   * See https://open.feishu.cn/document/event-subscription-guide/callback-subscription/callback-overview
   */
  @Post('feishu/card')
  feishuCard(
    @Body() body: unknown,
    @Req() req: { readonly headers: IncomingHttpHeaders },
  ): Record<string, unknown> {
    const adapter = this.registry.getFeishu();
    if (adapter === null) {
      this.logger.warn('feishu_card_callback_no_adapter');
      return {};
    }
    const result = adapter.handleHttpCardCallback(body, flattenHeaders(req.headers));
    if (result.kind === 'challenge') {
      return { challenge: result.challenge };
    }
    if (result.kind === 'ignored') {
      this.logger.warn(`feishu_card_callback_ignored reason=${result.reason}`);
      return {};
    }
    if (result.kind === 'replace_card') {
      // Feishu schema 2.0 callback contract: a `card` field in the
      // response body atomically replaces the card the user just clicked.
      // `type:"raw"` tells Feishu the payload is a v1 interactive-card
      // JSON (the same shape we use for the original send), not a card
      // template id. The toast renders briefly above the card.
      return {
        toast: { type: 'info', content: '已记录' },
        card: { type: 'raw', data: result.card },
      };
    }
    return { toast: { type: 'info', content: '处理中...' } };
  }
}
