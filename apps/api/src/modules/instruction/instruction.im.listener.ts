/**
 * Subscribes to `channel.inbound` events emitted by `ChannelBus`. Each
 * inbound IM message is routed through the executor; if it matches a
 * registered instruction the result is posted back to the same channel
 * via `ChannelService.send`. Casual chat (no leading `/`) is silently
 * ignored — the parser returns `no-prefix` and the listener bails out.
 *
 * Three reply paths:
 *   - **sync** instruction: handler runs inline; listener posts a single
 *     `instruction.reply` message carrying the result.
 *   - **async** instruction: handler is enqueued; listener posts a
 *     `instruction.async.started` message immediately (with jobId), and
 *     subscribes to `INSTRUCTION_ASYNC_COMPLETED_EVENT` to push a follow
 *     up `instruction.async.completed` message when the worker finishes.
 *   - **forbidden** sender (ACL): `errResult('forbidden', ...)` posted back
 *     so the user sees they were rejected. The check runs only after the
 *     parser confirms a `/`-prefixed instruction; casual chat from
 *     non-allowlisted senders stays silent.
 *
 * Trace id is generated per inbound and threaded into the executor ctx,
 * the outbound send, and (for async) the job payload so the full
 * Slack/Feishu → Nest → BullMQ → Slack/Feishu round-trip stays correlated.
 */

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  errResult,
  formatResult,
  newTraceId,
  parseInstructionLine,
  type ChannelId,
  type InstructionAsyncCompletedPayload,
  type InstructionResult,
} from '@quant/shared';

import { AuthService } from '../auth/auth.service.js';
import { ChannelService } from '../channel/channel.service.js';
import { CHANNEL_INBOUND_EVENT } from '../channel/bus/channel-bus.service.js';
import type { InboundMessage } from '../channel/ports/channel-adapter.port.js';

import {
  INSTRUCTION_ASYNC_COMPLETED_EVENT,
  type InstructionImHints,
} from './async/instruction-async.bus.js';
import { INSTRUCTION_CONFIG, type InstructionConfig } from './instruction.config.js';
import type { InstructionCtx } from './instruction.port.js';
import { InstructionExecutor } from './instruction.executor.js';
import { InstructionRegistry } from './instruction.registry.js';
import { ArgvParseError, parseArgvToObject } from './parse-argv.js';

interface PendingAsync {
  readonly channel: ChannelId;
  readonly target: string;
  readonly traceId: string;
  readonly instructionId: string;
}

type ReplyKind = 'instruction.reply' | 'instruction.async.started';

interface ReplyEnvelope {
  readonly result: InstructionResult;
  readonly kind: ReplyKind;
  readonly instructionId: string | null;
}

function reply(result: InstructionResult, instructionId: string | null): ReplyEnvelope {
  return { result, kind: 'instruction.reply', instructionId };
}

@Injectable()
export class InstructionImListener implements OnModuleInit {
  private readonly logger = new Logger(InstructionImListener.name);
  /** Bridges async jobs back to the IM thread that triggered them. */
  private readonly pendingByJobId = new Map<string, PendingAsync>();

  constructor(
    @Inject(InstructionRegistry) private readonly registry: InstructionRegistry,
    @Inject(InstructionExecutor) private readonly executor: InstructionExecutor,
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(INSTRUCTION_CONFIG) private readonly cfg: InstructionConfig,
  ) {}

  onModuleInit(): void {
    if (this.cfg.imAllowlist.size === 0) {
      this.logger.warn(
        'instruction_im_allowlist_open INSTRUCTION_IM_ALLOWLIST not set; any IM sender can run instructions (dev only)',
      );
    }
  }

  @OnEvent(CHANNEL_INBOUND_EVENT)
  async onInbound(msg: InboundMessage): Promise<void> {
    const traceId = newTraceId();
    const envelope = await this.dispatch(msg, traceId);
    if (envelope === null) return;
    await this.replyResult(msg, traceId, envelope);
  }

  /**
   * Async completions originate in the worker (see
   * `InstructionAsyncProcessor`) and arrive here through the in-process
   * EventEmitter2 bus. We push a follow-up card to the IM thread that
   * triggered the job, then drop the bridge entry. Completions for jobs
   * that didn't originate from IM (socket / http) are ignored here —
   * those clients consume the matching socket topic instead.
   */
  @OnEvent(INSTRUCTION_ASYNC_COMPLETED_EVENT)
  async onAsyncCompleted(payload: InstructionAsyncCompletedPayload): Promise<void> {
    const pending = this.pendingByJobId.get(payload.jobId);
    if (pending === undefined) return;
    this.pendingByJobId.delete(payload.jobId);
    try {
      await this.channels.send(
        pending.channel,
        {
          text: formatResult(payload.result),
          kind: 'instruction.async.completed',
          target: pending.target,
          meta: {
            ok: payload.result.ok,
            instructionId: payload.instructionId,
            jobId: payload.jobId,
            durationMs: payload.durationMs,
            ...(payload.result.ok ? {} : { code: payload.result.error.code }),
          },
        },
        { traceId: pending.traceId, source: 'system' },
      );
    } catch (err) {
      this.logger.warn(
        `instruction_async_completed_send_failed channel=${pending.channel} jobId=${payload.jobId} err=${String(err)}`,
      );
    }
  }

  private async dispatch(msg: InboundMessage, traceId: string): Promise<ReplyEnvelope | null> {
    const parsed = this.parseLine(msg.text);
    if (parsed.kind === 'silent') return null;
    if (parsed.kind === 'parse-error') {
      return reply(errResult('parse', parsed.reason), null);
    }
    const guard = this.applyAcl(msg, parsed.id);
    if (guard !== null) return guard;
    const entry = this.registry.get(parsed.id);
    if (entry === undefined) {
      return reply(errResult('not-found', `unknown instruction: ${parsed.id}`), parsed.id);
    }
    let rawArgs: Record<string, string>;
    try {
      rawArgs = parseArgvToObject(parsed.rest, entry.spec.positional ?? []);
    } catch (err) {
      const detail = err instanceof ArgvParseError ? err.message : String(err);
      return reply(errResult('parse', detail), parsed.id);
    }
    return this.runEntry(msg, traceId, parsed.id, entry.spec.mode === 'async', rawArgs);
  }

  private parseLine(
    text: string,
  ):
    | { readonly kind: 'silent' }
    | { readonly kind: 'parse-error'; readonly reason: string }
    | { readonly kind: 'ok'; readonly id: string; readonly rest: string } {
    const known = this.registry.knownIds();
    const parsed = parseInstructionLine(text, known, { requirePrefix: true });
    if (!parsed.ok) {
      if (parsed.reason === 'no-prefix') return { kind: 'silent' };
      return { kind: 'parse-error', reason: parsed.reason };
    }
    return { kind: 'ok', id: String(parsed.id), rest: parsed.rest };
  }

  private applyAcl(msg: InboundMessage, instructionId: string): ReplyEnvelope | null {
    if (this.cfg.imAllowlist.size === 0) return null;
    if (this.cfg.imAllowlist.has(msg.sender)) return null;
    this.logger.warn(
      `instruction_im_forbidden sender=${msg.sender} channel=${msg.channel} id=${instructionId}`,
    );
    return reply(errResult('forbidden', 'sender not in allowlist'), instructionId);
  }

  private async runEntry(
    msg: InboundMessage,
    traceId: string,
    instructionId: string,
    isAsync: boolean,
    rawArgs: Record<string, string>,
  ): Promise<ReplyEnvelope> {
    const resolved = await this.resolveImUser(msg);
    const replyTarget =
      msg.target !== undefined && msg.target.length > 0 ? msg.target : msg.sender;
    const ctx: InstructionCtx = {
      traceId,
      source: 'im',
      channelId: msg.channel,
      sender: msg.sender,
      ...(msg.target !== undefined && msg.target.length > 0 ? { target: msg.target } : {}),
      userId: resolved.userId,
      imBootstrap: resolved.imBootstrap,
      ...(resolved.originalUserId !== undefined
        ? { originalUserId: resolved.originalUserId }
        : {}),
    };
    const imHints: InstructionImHints | undefined = isAsync
      ? { channel: msg.channel, target: replyTarget }
      : undefined;
    const dispatched = await this.executor.dispatch(instructionId, rawArgs, ctx, imHints);
    if (dispatched.kind === 'async-queued') {
      this.pendingByJobId.set(dispatched.jobId, {
        channel: msg.channel,
        target: replyTarget,
        traceId,
        instructionId: dispatched.instructionId,
      });
      return {
        result: dispatched.result,
        kind: 'instruction.async.started',
        instructionId: dispatched.instructionId,
      };
    }
    return {
      result: dispatched.result,
      kind: 'instruction.reply',
      instructionId,
    };
  }

  private async replyResult(
    msg: InboundMessage,
    traceId: string,
    envelope: ReplyEnvelope,
  ): Promise<void> {
    const replyTarget = msg.target ?? msg.sender;
    try {
      await this.channels.send(
        msg.channel,
        {
          text: formatResult(envelope.result),
          kind: envelope.kind,
          ...(replyTarget.length > 0 ? { target: replyTarget } : {}),
          meta: {
            ok: envelope.result.ok,
            instructionId: envelope.instructionId,
            ...(envelope.result.ok ? {} : { code: envelope.result.error.code }),
          },
        },
        { traceId, source: 'system' },
      );
    } catch (err) {
      this.logger.warn(
        `instruction_reply_send_failed channel=${msg.channel} traceId=${traceId} err=${String(err)}`,
      );
    }
  }

  /**
   * Map an inbound IM sender to a canonical userId via `AuthService`.
   * Feishu senders like `feishu:ou_abc` resolve to userId `feishu:ou_abc`
   * (auto-creating the UserStore record on first contact). Channels we
   * don't yet have an OAuth provider for fall back to the legacy
   * `${channel}:${rest}` shape so the executor at least sees a stable id.
   */
  private async resolveImUser(
    msg: InboundMessage,
  ): Promise<{ userId: string; imBootstrap: boolean; originalUserId?: string }> {
    const user = await this.auth.resolveFromImChannel(msg.channel, msg.sender);
    return {
      userId: user.id,
      imBootstrap: user.imBootstrap,
      ...(user.originalUserId !== undefined ? { originalUserId: user.originalUserId } : {}),
    };
  }
}
