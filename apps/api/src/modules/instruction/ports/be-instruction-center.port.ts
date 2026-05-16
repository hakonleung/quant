/**
 * Port interface for `BeInstructionCenter` — narrow surface that lets
 * `InstructionRegistry` and `InstructionExecutor` defer to the center
 * without value-level imports of the concrete class.
 *
 * Why this exists: BeInstructionCenter's constructor needs the
 * services of every migrated feature module (sentiment, ledger, ta,
 * agent, …). Once `AgentService` is one of those deps, we get an
 * ES-modules cycle:
 *
 *   instruction.executor.ts → BeInstructionCenter → AgentService
 *     → AgentToolBridge → instruction.executor.ts                    ← back-edge
 *
 * Routing the executor/registry → center edge through this port (token
 * + interface) flips that import to type-only, breaking the cycle.
 * NestJS still wires the same concrete singleton at runtime via
 * `useExisting: BeInstructionCenter`.
 */

import type { InstructionResult } from '@quant/shared';

import type { InstructionCtx } from '../instruction.port.js';

export const BE_INSTRUCTION_CENTER_PORT = Symbol('BE_INSTRUCTION_CENTER_PORT');

export interface BeInstructionCenterPort {
  /** True when this center owns the instruction (legacy executor must defer). */
  has(id: string): boolean;
  /** Ids the center has cells for — unioned into the registry's coverage assertion. */
  ids(): readonly string[];
  /**
   * Args-validated invoke. The executor's `route()` zod-parses args
   * against the manifest schema before calling this — center cells
   * receive typed input.
   */
  executeMigrated(id: string, args: unknown, ctx: InstructionCtx): Promise<InstructionResult>;
  /**
   * IM paid-confirm bypass probe. Returns `false` when the cell has
   * no `peek` hook (i.e. "always show the IM confirm card").
   */
  peekImConfirmBypass(
    id: string,
    rawArgs: Record<string, unknown>,
    ctx: InstructionCtx,
  ): Promise<boolean>;
  /**
   * HTTP-friendly typed invoke — runs the cell handler and returns
   * the raw `ResultOf<I>` payload (no `InstructionResult` envelope,
   * no renderer pass). The new `POST /api/instructions/:id` endpoint
   * uses this so the FE shell receives the same typed data the BE
   * renderer would, ready to feed into the FE cell renderer.
   *
   * Throws on cell handler failure; caller is responsible for
   * mapping to HTTP error responses.
   */
  invokeRaw(id: string, args: unknown, ctx: InstructionCtx): Promise<unknown>;
}
