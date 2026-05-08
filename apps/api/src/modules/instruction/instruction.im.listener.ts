/**
 * Subscribes to `channel.inbound` events emitted by `ChannelBus`. Each
 * inbound IM message is routed through the executor; if it matches a
 * registered instruction the result is posted back to the same channel
 * via `ChannelService.send`. Casual chat (no leading `/`) is silently
 * ignored — the parser returns `no-prefix` and the listener bails out.
 *
 * Trace id is generated per inbound and threaded into both the executor
 * ctx and the outbound send so request correlation works across the
 * full Slack/Feishu → Nest → BullMQ → Slack/Feishu round-trip.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  errResult,
  formatResult,
  newTraceId,
  parseInstructionLine,
  type InstructionResult,
} from '@quant/shared';

import { ChannelService } from '../channel/channel.service.js';
import { CHANNEL_INBOUND_EVENT } from '../channel/bus/channel-bus.service.js';
import type { InboundMessage } from '../channel/ports/channel-adapter.port.js';

import type { InstructionCtx } from './instruction.port.js';
import { InstructionExecutor } from './instruction.executor.js';
import { InstructionRegistry } from './instruction.registry.js';
import { ArgvParseError, parseArgvToObject } from './parse-argv.js';

@Injectable()
export class InstructionImListener {
  private readonly logger = new Logger(InstructionImListener.name);

  constructor(
    @Inject(InstructionRegistry) private readonly registry: InstructionRegistry,
    @Inject(InstructionExecutor) private readonly executor: InstructionExecutor,
    @Inject(ChannelService) private readonly channels: ChannelService,
  ) {}

  @OnEvent(CHANNEL_INBOUND_EVENT)
  async onInbound(msg: InboundMessage): Promise<void> {
    const traceId = newTraceId();
    const result = await this.dispatch(msg, traceId);
    if (result === null) return; // casual chat — no reply
    const replyTarget = msg.target ?? msg.sender;
    try {
      await this.channels.send(
        msg.channel,
        {
          text: formatResult(result),
          kind: 'instruction.reply',
          ...(replyTarget.length > 0 ? { target: replyTarget } : {}),
        },
        { traceId, source: 'system' },
      );
    } catch (err) {
      this.logger.warn(
        `instruction_reply_send_failed channel=${msg.channel} traceId=${traceId} err=${String(err)}`,
      );
    }
  }

  private async dispatch(msg: InboundMessage, traceId: string): Promise<InstructionResult | null> {
    const known = this.registry.knownIds();
    const parsed = parseInstructionLine(msg.text, known, { requirePrefix: true });
    if (!parsed.ok) {
      if (parsed.reason === 'no-prefix') return null;
      return errResult('parse', parsed.reason);
    }
    const entry = this.registry.get(parsed.id);
    if (entry === undefined) return errResult('not-found', `unknown instruction: ${parsed.id}`);
    let rawArgs: Record<string, string>;
    try {
      rawArgs = parseArgvToObject(parsed.rest, entry.spec.positional ?? []);
    } catch (err) {
      const detail = err instanceof ArgvParseError ? err.message : String(err);
      return errResult('parse', detail);
    }
    const ctx: InstructionCtx = {
      traceId,
      source: 'im',
      channelId: msg.channel,
      sender: msg.sender,
      ...(msg.target !== undefined && msg.target.length > 0 ? { target: msg.target } : {}),
    };
    return this.executor.execute(parsed.id, rawArgs, ctx);
  }
}
