/**
 * Executes an instruction by id (socket / http path) or by raw line
 * (IM path). Validates args via the spec's zod schema before invoking
 * the handler, and converts thrown errors into a structured
 * `{ ok: false, error: { code: 'handler' } }` result so the IM reply
 * never leaks a stack trace.
 *
 * Two surfaces:
 *   - `execute(id, args, ctx, imHints?)` / `executeLine(line, ctx)`:
 *     classic InstructionResult-shaped APIs. Async-mode handlers return
 *     a `▶ /<id> queued (jobId=…)` started result.
 *   - `dispatch(id, args, ctx, imHints?)`: returns a tagged envelope
 *     (`{ kind: 'sync', result }` or `{ kind: 'async-queued', jobId,
 *     instructionId }`). The IM listener uses this to bridge async
 *     completions back to the originating IM thread without parsing
 *     jobIds out of formatted text.
 *
 * Routing: every call funnels through `route(entry, args, ctx, imHints)`.
 *   - sync mode (default) → handler runs inline.
 *   - async mode → args are zod-validated synchronously (so bad input
 *     surfaces immediately), then enqueued onto the
 *     `instruction.async` BullMQ queue; the call returns the jobId.
 *     Completion comes back through `InstructionAsyncBus.emitCompleted`.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { errResult, okResult, parseInstructionLine, type InstructionResult } from '@quant/shared';
import { randomUUID } from 'node:crypto';

import { CLOCK, type Clock } from '../../common/clock.js';
import {
  InstructionAsyncBus,
  type InstructionAsyncJob,
  type InstructionImHints,
} from './async/instruction-async.bus.js';
import { InstructionRegistry, type InstructionEntry } from './instruction.registry.js';
import type { AnyInstructionHandler, InstructionCtx } from './instruction.port.js';
import { ArgvParseError, parseArgvToObject } from './parse-argv.js';

export type ExecutionDispatch =
  | { readonly kind: 'sync'; readonly result: InstructionResult }
  | {
      readonly kind: 'async-queued';
      readonly jobId: string;
      readonly instructionId: string;
      readonly result: InstructionResult;
    };

@Injectable()
export class InstructionExecutor {
  private readonly logger = new Logger(InstructionExecutor.name);

  constructor(
    @Inject(InstructionRegistry) private readonly registry: InstructionRegistry,
    @Inject(InstructionAsyncBus) private readonly asyncBus: InstructionAsyncBus,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Structured entry — id + already-decoded args. Used by socket/http. */
  async execute(
    id: string,
    args: Record<string, unknown>,
    ctx: InstructionCtx,
    imHints?: InstructionImHints,
  ): Promise<InstructionResult> {
    const dispatched = await this.dispatch(id, args, ctx, imHints);
    return dispatched.result;
  }

  /**
   * Same as `execute` but exposes the dispatch envelope so the IM
   * listener can bridge async completions back to the originating
   * channel/target without parsing jobId out of formatted text.
   */
  async dispatch(
    id: string,
    args: Record<string, unknown>,
    ctx: InstructionCtx,
    imHints?: InstructionImHints,
  ): Promise<ExecutionDispatch> {
    const entry = this.registry.get(id);
    if (entry === undefined) {
      return { kind: 'sync', result: errResult('not-found', `unknown instruction: ${id}`) };
    }
    return this.route(entry, args, ctx, imHints);
  }

  /**
   * Line entry — parses the leading id, tokenizes the rest into a
   * `Record<string, string>`, then delegates to `execute`. Used by the
   * IM listener (and any future text-driven entry point).
   */
  async executeLine(line: string, ctx: InstructionCtx): Promise<InstructionResult> {
    const parsed = parseInstructionLine(line, this.registry.knownIds(), { requirePrefix: false });
    if (!parsed.ok) {
      return errResult('parse', parsed.reason);
    }
    const entry = this.registry.get(parsed.id);
    if (entry === undefined) {
      return errResult('not-found', `unknown instruction: ${String(parsed.id)}`);
    }
    let rawArgs: Record<string, string>;
    try {
      rawArgs = parseArgvToObject(parsed.rest, entry.spec.positional ?? []);
    } catch (err) {
      const msg = err instanceof ArgvParseError ? err.message : String(err);
      return errResult('parse', msg);
    }
    const dispatched = await this.route(entry, rawArgs, ctx, undefined);
    return dispatched.result;
  }

  private async route(
    entry: InstructionEntry,
    args: Record<string, unknown>,
    ctx: InstructionCtx,
    imHints: InstructionImHints | undefined,
  ): Promise<ExecutionDispatch> {
    const validation = entry.spec.argsSchema.safeParse(args);
    if (!validation.success) {
      const issues = validation.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return { kind: 'sync', result: errResult('validation', issues) };
    }
    if (entry.spec.mode === 'async') {
      return this.enqueueAsync(entry, args, ctx, imHints);
    }
    const handler: AnyInstructionHandler = entry.handler;
    try {
      const result = await handler.execute(validation.data, ctx);
      return { kind: 'sync', result };
    } catch (err) {
      this.logger.warn(
        `instruction_handler_throw id=${String(entry.spec.id)} traceId=${ctx.traceId} err=${String(err)}`,
      );
      return {
        kind: 'sync',
        result: errResult('handler', err instanceof Error ? err.message : String(err)),
      };
    }
  }

  private async enqueueAsync(
    entry: InstructionEntry,
    rawArgs: Record<string, unknown>,
    ctx: InstructionCtx,
    imHints: InstructionImHints | undefined,
  ): Promise<ExecutionDispatch> {
    const jobId = randomUUID();
    const instructionId = String(entry.spec.id);
    const job: InstructionAsyncJob = {
      jobId,
      instructionId,
      rawArgs,
      ctx,
      ...(imHints !== undefined ? { im: imHints } : {}),
      enqueuedAt: this.clock.now().toISOString(),
    };
    try {
      await this.asyncBus.enqueue(job);
    } catch (err) {
      this.logger.warn(
        `instruction_async_enqueue_failed id=${instructionId} traceId=${ctx.traceId} err=${String(err)}`,
      );
      return {
        kind: 'sync',
        result: errResult('handler', `failed to enqueue async job: ${String(err)}`),
      };
    }
    const startedText = `▶ /${instructionId} queued (jobId=${jobId})`;
    return {
      kind: 'async-queued',
      jobId,
      instructionId,
      result: okResult(startedText),
    };
  }
}
