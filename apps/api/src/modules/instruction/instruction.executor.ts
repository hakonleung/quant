/**
 * Executes an instruction by id (socket / http path) or by raw line
 * (IM path). Validates args via the spec's zod schema before invoking
 * the handler, and converts thrown errors into a structured
 * `{ ok: false, error: { code: 'handler' } }` result so the IM reply
 * never leaks a stack trace.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  errResult,
  parseInstructionLine,
  type InstructionResult,
} from '@quant/shared';

import { InstructionRegistry, type InstructionEntry } from './instruction.registry.js';
import type { AnyInstructionHandler, InstructionCtx } from './instruction.port.js';
import { ArgvParseError, parseArgvToObject } from './parse-argv.js';

@Injectable()
export class InstructionExecutor {
  private readonly logger = new Logger(InstructionExecutor.name);

  constructor(@Inject(InstructionRegistry) private readonly registry: InstructionRegistry) {}

  /** Structured entry — id + already-decoded args. Used by socket/http. */
  async execute(
    id: string,
    args: Record<string, unknown>,
    ctx: InstructionCtx,
  ): Promise<InstructionResult> {
    const entry = this.registry.get(id);
    if (entry === undefined) {
      return errResult('not-found', `unknown instruction: ${id}`);
    }
    return this.runEntry(entry, args, ctx);
  }

  /**
   * Line entry — parses the leading id, tokenizes the rest into a
   * `Record<string, string>`, then delegates to `execute`. Used by the
   * IM listener.
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
    return this.runEntry(entry, rawArgs, ctx);
  }

  private async runEntry(
    entry: InstructionEntry,
    args: Record<string, unknown>,
    ctx: InstructionCtx,
  ): Promise<InstructionResult> {
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
        `instruction_handler_throw id=${String(entry.spec.id)} traceId=${ctx.traceId} err=${String(err)}`,
      );
      return errResult('handler', err instanceof Error ? err.message : String(err));
    }
  }
}
