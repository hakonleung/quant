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

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  errResult,
  okResult,
  parseInstructionLine,
  INSTRUCTION_MANIFEST,
  type CommandManifestEntry,
  type InstructionResult,
} from '@quant/shared';
import { randomUUID } from 'node:crypto';

import { CLOCK, type Clock } from '../../common/clock.js';
import {
  InstructionAsyncBus,
  type InstructionAsyncJob,
  type InstructionImHints,
} from './async/instruction-async.bus.js';
import {
  BE_INSTRUCTION_CENTER_PORT,
  type BeInstructionCenterPort,
} from './ports/be-instruction-center.port.js';
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
    @Optional()
    @Inject(BE_INSTRUCTION_CENTER_PORT)
    private readonly center: BeInstructionCenterPort | null = null,
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
    const entry = this.resolveEntry(id);
    if (entry === undefined) {
      return { kind: 'sync', result: errResult('not-found', `unknown instruction: ${id}`) };
    }
    return this.route(entry, args, ctx, imHints);
  }

  /**
   * Run an instruction's handler **inline**, bypassing the async-mode
   * routing in `route()`. Used by:
   *   - `InstructionAsyncProcessor` — the worker has already pulled the
   *     job off the queue, so re-routing through `enqueueAsync` would
   *     recursively re-enqueue and the actual result would never reach
   *     the user (manifests as IM showing "▶ /ta queued (jobId=…)" and
   *     never the analysis).
   *   - `AgentToolBridge` — when the agent loop calls `/ta` / `/screen`
   *     mid-loop, we want the handler to run synchronously so the result
   *     can be appended as a `role:'tool'` message; otherwise the agent
   *     just sees a queued ack and stalls.
   *
   * Args are zod-validated here too so callers can pass raw input.
   * Handler throws are mapped to `errResult('handler', …)` for symmetry
   * with `route()`.
   */
  async executeHandler(
    id: string,
    args: Record<string, unknown>,
    ctx: InstructionCtx,
  ): Promise<InstructionResult> {
    const entry = this.resolveEntry(id);
    if (entry === undefined) {
      return errResult('not-found', `unknown instruction: ${id}`);
    }
    const validation = entry.spec.argsSchema.safeParse(args);
    if (!validation.success) {
      const issues = validation.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return errResult('validation', issues);
    }
    const handler: AnyInstructionHandler = entry.handler;
    try {
      return await handler.execute(validation.data, ctx);
    } catch (err) {
      this.logger.warn(
        `instruction_handler_throw id=${id} traceId=${ctx.traceId} err=${String(err)}`,
      );
      return errResult('handler', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Line entry — parses the leading id, tokenizes the rest into a
   * `Record<string, string>`, then delegates to `execute`. Used by the
   * IM listener (and any future text-driven entry point).
   */
  async executeLine(line: string, ctx: InstructionCtx): Promise<InstructionResult> {
    const parsed = parseInstructionLine(line, this.knownIds(), { requirePrefix: false });
    if (!parsed.ok) {
      return errResult('parse', parsed.reason);
    }
    const entry = this.resolveEntry(parsed.id);
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

  /**
   * Look up an instruction by id, checking the migrated-cell center
   * first then the legacy registry. Migrated ids materialise a
   * synthetic `InstructionEntry` whose handler delegates to
   * `BeInstructionCenter.executeMigrated` — that way the existing
   * `route()` flow (with its sync/async split, argsSchema validation,
   * and async enqueue logic) works uniformly.
   */
  private resolveEntry(id: string): InstructionEntry | undefined {
    if (this.center !== null && this.center.has(id)) {
      return this.synthesiseCenterEntry(id);
    }
    return this.registry.get(id);
  }

  /**
   * Merge legacy registry tokens with center-owned ids so
   * `parseInstructionLine` accepts both. Migrated ids don't carry
   * extra aliases in the manifest today (the few that do — e.g. `usr`
   * with `['我的', '账号', '我']` — are added here from the shared
   * manifest).
   */
  private knownIds(): ReadonlyMap<string, string> {
    const out = new Map(this.registry.knownIds());
    if (this.center !== null) {
      for (const id of this.center.ids()) {
        out.set(id, id);
        const entry = manifestEntryOf(id);
        if (entry !== undefined) {
          for (const a of entry.aliases ?? []) out.set(a, id);
        }
      }
    }
    return out;
  }

  private synthesiseCenterEntry(id: string): InstructionEntry {
    const manifestEntry = manifestEntryOf(id);
    if (manifestEntry === undefined) {
      throw new Error(`center has id "${id}" but it is missing from the manifest`);
    }
    const center = this.center;
    if (center === null) {
      throw new Error('synthesiseCenterEntry called without a center');
    }
    const spec = {
      id: id as InstructionEntry['spec']['id'],
      summary: manifestEntry.summary,
      summaryCn: manifestEntry.summaryCn ?? manifestEntry.summary,
      group: 'system' as InstructionEntry['spec']['group'],
      argsSchema:
        manifestEntry.argsSchema ??
        ({
          safeParse: () => ({ success: true, data: {} }),
        } as unknown as InstructionEntry['spec']['argsSchema']),
      ...(manifestEntry.mode !== undefined ? { mode: manifestEntry.mode } : {}),
      // Translate the new manifest fields back to the legacy
      // InstructionSpec field names. Legacy handlers (the few not yet
      // migrated to InstructionCenter cells) and the IM listener still
      // read these; preserving the shim keeps the registry path working
      // until phase-3 FE migration removes that surface entirely.
      ...(manifestEntry.aliases !== undefined ? { imAliases: manifestEntry.aliases } : {}),
      ...(manifestEntry.doubleConfirm === 'llm' ? { costsCredits: true as const } : {}),
      ...(manifestEntry.doubleConfirm === 'destructive'
        ? { destructive: true as const }
        : {}),
      ...(manifestEntry.imGate === true ? { requiresImConfirm: true as const } : {}),
    } as unknown as InstructionEntry['spec'];
    const handler: AnyInstructionHandler = {
      execute: (args, ctx) => center.executeMigrated(id, args, ctx),
      // Forward the IM listener's confirm-bypass probe into the cell's
      // optional `peek` hook. The cell layer treats "no peek defined" as
      // `false` (always show the card); centre returns the same.
      peekImConfirmBypass: (rawArgs, ctx) => center.peekImConfirmBypass(id, rawArgs, ctx),
    };
    return { spec, handler };
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

/**
 * Manifest entry lookup widened to the base `CommandManifestEntry`
 * shape so optional fields (`aliases`, `imAliases`, `summaryCn`, …)
 * are accessible without per-entry literal narrowing.
 */
function manifestEntryOf(id: string): CommandManifestEntry | undefined {
  const entry = (INSTRUCTION_MANIFEST as Record<string, CommandManifestEntry | undefined>)[id];
  return entry;
}
