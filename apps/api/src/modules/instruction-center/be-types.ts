/**
 * BE-side environment for `InstructionCenter`. Defines the per-side
 * `ctx` (handler dependency bag) and `host` (renderer dependency bag)
 * plus the renderer return type.
 *
 * `ctx` is per-call (carries `userId` / `traceId`); long-lived services
 * (LedgerStore, AuthConfig) are captured in each cell's factory closure
 * — that's what the NestJS provider wiring does.
 *
 * `output` is `InstructionResult` (the legacy envelope) so the IM
 * listener and async bus can consume cell output without conversion.
 * Phase-2 follow-up may introduce a richer BE output (e.g. native
 * lark card payloads) if needed.
 */

import type { InstructionResult } from '@quant/shared';

import type { InstructionCtx } from '../instruction/instruction.port.js';

export interface BeCtx extends InstructionCtx {}

/**
 * Renderer dependency bag for BE cells. Empty today — every BE renderer
 * is a pure transform from typed data to `InstructionResult` (which the
 * IM listener / async bus then ships to the channel adapter). Kept as
 * an explicit shape so cells declare what host capability they touch
 * the moment one is needed (e.g. a markdown table builder, a feishu
 * card factory).
 */
export interface ImHost {}

export type ImOutput = InstructionResult;

export interface BeEnv {
  ctx: BeCtx;
  host: ImHost;
  output: ImOutput;
}
