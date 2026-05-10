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

/**
 * Category used by `help` to group instructions.
 *   - `market`:    行情 — stock lookup, screening, sectors
 *   - `portfolio`: 持仓 — ledger, analysis
 *   - `watch`:     预警 — watch tasks
 *   - `system`:    系统 — meta, debug, infra
 */
export type InstructionGroup = 'market' | 'portfolio' | 'watch' | 'system';

export interface InstructionSpec<TArgs> {
  readonly id: InstructionId;
  /** English one-liner shown in the help list and detail view. */
  readonly summary: string;
  /** Chinese one-liner shown alongside `summary` in bilingual help output. */
  readonly summaryCn: string;
  readonly help?: string;
  /** Category for grouping in `help` output. */
  readonly group: InstructionGroup;
  readonly argsSchema: z.ZodType<TArgs, z.ZodTypeDef, unknown>;
  readonly positional?: readonly string[];
  /** ASCII aliases validated against InstructionId regex (e.g. dotted forms). */
  readonly aliases?: readonly InstructionId[];
  /**
   * Free-form IM aliases that bypass the InstructionId regex — intended for
   * human-language tokens such as Chinese characters (e.g. `['分析', '选股']`).
   * These only work in IM and terminal contexts; they are not valid InstructionIds.
   */
  readonly imAliases?: readonly string[];
  readonly mode?: InstructionMode;
  /**
   * `true` when the instruction triggers a paid external LLM call (or a
   * cache-write that performs one). The `/agent` loop uses this:
   *   - the user pays a one-time confirmation before /agent starts;
   *   - any tool call inside the loop with `costsCredits=true` triggers
   *     a per-tool confirmation card / widget.
   * Help renders a `[$]` tag against these instructions.
   */
  readonly costsCredits?: boolean;
  /**
   * `true` when the instruction performs a write that is not trivially
   * reversible (cache regeneration, blacklist refresh, …). Mirrors the
   * `costsCredits` confirmation behaviour inside the `/agent` loop, and
   * help renders a `[!]` tag.
   */
  readonly destructive?: boolean;
  /**
   * Concrete invocation examples shown by `/help <id>` (and its IM
   * detail card). Each entry is a full command line, e.g.
   * `'sector.show s1'` or `'ledger limit=10'`. Falls back to a
   * positional-derived stub when omitted.
   */
  readonly examples?: readonly string[];
}

/**
 * The registry stores specs as `InstructionSpec<unknown>` because their
 * arg types are only known to their handlers. Handlers receive their
 * concrete `TArgs` through a private cast inside the executor that is
 * justified by the matching zod parse — no other call sites should
 * touch the unknown form.
 */
export type AnyInstructionSpec = InstructionSpec<unknown>;
