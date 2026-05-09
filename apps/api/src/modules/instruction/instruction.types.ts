/**
 * Backend instruction spec. Carries the per-handler contract:
 *   - id   : matches the FE `@quant/terminal` command name where
 *            applicable (`focus`, `screen`, `watch`, ...)
 *   - args : zod schema; the executor parses every payload through it
 *            so handlers receive typed, validated input
 *   - positional : declares which top-level positional tokens map to
 *                  which arg key. `parseArgv` turns
 *                  `focus 600519` into `{ code: '600519' }`.
 *   - aliases    : alternate ids accepted by the registry (e.g. dotted
 *                  forms `watch.list` for IM ergonomics).
 *
 * FE/BE specs deliberately diverge — the FE side already has a richer
 * `CommandSpec` with tab-completion and interactive widgets that have
 * no BE meaning (CLAUDE.md §2.5.2 Rule of Three).
 */

import type { InstructionId } from '@quant/shared';
import type { z } from 'zod';

/**
 * `argsSchema` is typed against `unknown` input on purpose: zod schemas
 * built with `.default(...)` / `.optional()` have an input type wider
 * than their output, and binding the input to `TArgs` makes such
 * schemas un-assignable to `InstructionSpec<TArgs>`. The executor
 * always feeds `safeParse` a `Record<string, unknown>` from the argv
 * tokenizer, so `unknown` is the honest input contract.
 */
/**
 * Execution mode:
 *   - `sync` (default): handler runs inline; the result reaches the IM
 *     reply / socket ack within a single request/response.
 *   - `async`: handler runs on the `instruction.async` BullMQ worker
 *     (`InstructionAsyncProcessor`). The IM listener immediately replies
 *     with a "started" card and pushes a "completed" card later when the
 *     worker finishes. Used for LLM-bound or otherwise multi-second ops.
 */
export type InstructionMode = 'sync' | 'async';

export interface InstructionSpec<TArgs> {
  readonly id: InstructionId;
  readonly summary: string;
  readonly help?: string;
  readonly argsSchema: z.ZodType<TArgs, z.ZodTypeDef, unknown>;
  readonly positional?: readonly string[];
  readonly aliases?: readonly InstructionId[];
  readonly mode?: InstructionMode;
}

/**
 * The registry stores specs as `InstructionSpec<unknown>` because their
 * arg types are only known to their handlers. Handlers receive their
 * concrete `TArgs` through a private cast inside the executor that is
 * justified by the matching zod parse — no other call sites should
 * touch the unknown form.
 */
export type AnyInstructionSpec = InstructionSpec<unknown>;
