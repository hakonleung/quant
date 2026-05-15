/**
 * Subscribes to `channel.inbound` events emitted by `ChannelBus`. Each
 * inbound IM message is matched against registered instructions by the
 * first token (no leading `/` required); unrecognised messages are
 * silently ignored. Chinese aliases (e.g. `分析`, `筛选`) and ASCII
 * aliases resolve to their canonical id via the registry's knownIds map.
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
 *     parser confirms a known instruction; casual chat from non-allowlisted
 *     senders stays silent.
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

type ReplyKind =
  | 'instruction.reply'
  | 'instruction.async.started'
  | 'agent.paid_confirm'
  | 'instruction.paid_confirm';

interface ReplyEnvelope {
  readonly result: InstructionResult;
  readonly kind: ReplyKind;
  readonly instructionId: string | null;
  /** Extra meta fields the card builder reads. */
  readonly meta?: Readonly<Record<string, unknown>>;
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
    // null means either: unrecognised message, or async instruction that
    // has been silently queued — the result arrives via onAsyncCompleted.
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
      // Forward handler-side `output.meta` (e.g. `stockTableRows`) the
      // same way the sync path does, so async screen / TA results render
      // through the native Feishu table when the handler emits one.
      const handlerMeta =
        payload.result.ok && payload.result.output.meta !== undefined
          ? payload.result.output.meta
          : undefined;
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
            ...(handlerMeta ?? {}),
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
    if (parsed.kind === 'silent') {
      // No instruction matched — fall back to the natural-language /agent
      // entry point, but keep ACL gating: only allowlisted senders get
      // routed; everyone else still stays silent.
      return this.fallbackToAgent(msg, traceId);
    }
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

  private isConfirmTokenSet(rawArgs: Record<string, string>): boolean {
    const v = rawArgs['confirm'];
    if (v === undefined) return false;
    const n = v.toLowerCase();
    return n === '1' || n === 'true' || n === 'yes';
  }

  /**
   * Decide whether to interpose the paid-confirm card. Returns the
   * envelope when the gate should fire, or `null` to fall through to
   * normal dispatch. The `requiresImConfirm` spec flag is a hard
   * prerequisite; on top of that we honour two bypasses:
   *
   *   1. Caller already passed `confirm=1` via the card-button round-trip.
   *   2. Handler exposes `peekImConfirmBypass(rawArgs, ctx)` and reports
   *      a cache hit — the work is free, so don't bother the user.
   *      Probe failures fall through to the gate (fail closed).
   */
  private async maybePaidConfirmGate(
    instructionId: string,
    rawArgs: Record<string, string>,
    ctx: InstructionCtx,
  ): Promise<ReplyEnvelope | null> {
    const entry = this.registry.get(instructionId);
    if (entry?.spec.requiresImConfirm !== true) return null;
    if (this.isConfirmTokenSet(rawArgs)) return null;
    const peek = entry.handler.peekImConfirmBypass?.bind(entry.handler);
    if (peek !== undefined) {
      try {
        if (await peek(rawArgs, ctx)) return null;
      } catch (err) {
        this.logger.warn(
          `paid_confirm_peek_failed id=${instructionId} traceId=${ctx.traceId} err=${String(err)}`,
        );
      }
    }
    return this.buildGenericPaidConfirm(instructionId, rawArgs);
  }

  private buildGenericPaidConfirm(
    instructionId: string,
    rawArgs: Record<string, string>,
  ): ReplyEnvelope {
    const argsForCard: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawArgs)) {
      if (k === 'confirm') continue;
      argsForCard[k] = v;
    }
    return {
      result: errResult(
        'confirm-required',
        JSON.stringify({ kind: 'paid', cmd: instructionId, args: argsForCard }),
      ),
      kind: 'instruction.paid_confirm',
      instructionId,
      meta: { confirmCmd: instructionId, confirmArgs: argsForCard },
    };
  }

  /**
   * Casual-chat fallback: route the bare message to `/agent q="<text>"`.
   * Skipped for empty / whitespace bodies and gated on the same allowlist
   * as explicit commands, so non-allowlisted senders stay silent.
   *
   * The first /agent call always returns the "needs confirmation" reply
   * because `/agent` is `costsCredits`; the user must accept via the
   * Feishu button card before any LLM call fires.
   */
  private async fallbackToAgent(
    msg: InboundMessage,
    traceId: string,
  ): Promise<ReplyEnvelope | null> {
    const text = msg.text.trim();
    if (text.length === 0) return null;
    const guard = this.applyAcl(msg, 'agent');
    if (guard !== null) {
      // Don't surface "forbidden" for casual chat — keep IM polite.
      return null;
    }
    const entry = this.registry.get('agent');
    if (entry === undefined) {
      // /agent is registered as part of AgentModule; if it isn't there,
      // fallback should be inert rather than chatty.
      return null;
    }
    return this.runEntry(msg, traceId, 'agent', entry.spec.mode === 'async', { q: text });
  }

  private parseLine(
    text: string,
  ):
    | { readonly kind: 'silent' }
    | { readonly kind: 'parse-error'; readonly reason: string }
    | { readonly kind: 'ok'; readonly id: string; readonly rest: string } {
    const known = this.registry.knownIds();
    const parsed = parseInstructionLine(text, known, { requirePrefix: false });
    if (!parsed.ok) {
      // A `/`-prefixed unknown token signals explicit command intent — reply
      // with an error so the user knows the command doesn't exist.
      // A bare unrecognised token is casual chat — stay silent.
      if (parsed.reason === 'not-found' && text.trimStart().startsWith('/')) {
        return { kind: 'parse-error', reason: parsed.reason };
      }
      return { kind: 'silent' };
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

  private async buildImCtx(
    msg: InboundMessage,
    traceId: string,
  ): Promise<{ readonly ctx: InstructionCtx; readonly replyTarget: string }> {
    const resolved = await this.resolveImUser(msg);
    const replyTarget = msg.target !== undefined && msg.target.length > 0 ? msg.target : msg.sender;
    const ctx: InstructionCtx = {
      traceId,
      source: 'im',
      channelId: msg.channel,
      sender: msg.sender,
      ...(msg.target !== undefined && msg.target.length > 0 ? { target: msg.target } : {}),
      userId: resolved.userId,
      imBootstrap: resolved.imBootstrap,
      ...(resolved.originalUserId !== undefined ? { originalUserId: resolved.originalUserId } : {}),
    };
    return { ctx, replyTarget };
  }

  private async runEntry(
    msg: InboundMessage,
    traceId: string,
    instructionId: string,
    isAsync: boolean,
    rawArgs: Record<string, string>,
  ): Promise<ReplyEnvelope | null> {
    const { ctx, replyTarget } = await this.buildImCtx(msg, traceId);
    const imHints: InstructionImHints | undefined = isAsync
      ? { channel: msg.channel, target: replyTarget }
      : undefined;
    // Paid-confirm gate (generic): for instructions tagged
    // `requiresImConfirm`, intercept the first call and ask for explicit
    // approval before the (typically `costsCredits`) handler runs. The
    // card button echoes back `/<id> confirm=1 <args>` so the second
    // pass falls through. Distinct from `/agent`'s handler-internal
    // gate (preserved below) — that one builds a different card.
    const gate = await this.maybePaidConfirmGate(instructionId, rawArgs, ctx);
    if (gate !== null) return gate;
    const dispatched = await this.executor.dispatch(instructionId, rawArgs, ctx, imHints);
    if (dispatched.kind === 'async-queued') {
      this.pendingByJobId.set(dispatched.jobId, {
        channel: msg.channel,
        target: replyTarget,
        traceId,
        instructionId: dispatched.instructionId,
      });
      return null;
    }
    return this.envelopeFromDispatch(instructionId, dispatched.result);
  }

  /**
   * Map a sync dispatch result onto the IM reply envelope, including
   * the `/agent` confirm-required → agent.paid_confirm card upgrade.
   * Pulled out of `runEntry` so the orchestrator stays under the
   * 50-line / complexity-10 ceiling.
   */
  private envelopeFromDispatch(instructionId: string, result: InstructionResult): ReplyEnvelope {
    if (!result.ok && result.error.code === 'confirm-required' && instructionId === 'agent') {
      const envelope = decodeAgentPaidConfirm(result.error.message);
      return {
        result,
        kind: 'agent.paid_confirm',
        instructionId,
        meta: { agentQ: envelope.q ?? '' },
      };
    }
    const handlerMeta =
      result.ok && result.output.meta !== undefined ? result.output.meta : undefined;
    return {
      result,
      kind: 'instruction.reply',
      instructionId,
      ...(handlerMeta !== undefined ? { meta: handlerMeta } : {}),
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
            ...(envelope.meta ?? {}),
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

/**
 * The /agent handler hands its `confirm-required` payload back as a
 * JSON-encoded `error.message` so the IM card builder can pull the
 * original `q` out without round-tripping a parallel meta channel.
 * Tolerates non-JSON / missing fields by yielding empty strings; the
 * card just renders "" placeholders rather than crashing.
 */
function decodeAgentPaidConfirm(message: string): { readonly q: string | null } {
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed === 'object' && parsed !== null) {
      const q = (parsed as { q?: unknown }).q;
      return { q: typeof q === 'string' ? q : null };
    }
  } catch {
    // fallthrough
  }
  return { q: null };
}
