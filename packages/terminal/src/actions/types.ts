/**
 * Public types for the data-action abstraction. Pure types — no IO
 * (CLAUDE.md §2.5.1). Importing this from a unit test must not pull in
 * `fetch`, react-query, or zustand.
 */

import type { z } from 'zod';

export type ActionKind = 'read' | 'write' | 'paid';

/**
 * `args` and `result` are intentionally untyped at the schema level
 * (`z.ZodTypeAny`). The phantom A / R type parameters carry the *runtime*
 * shape produced by `zod.parse(...)`, which differs from `z.infer<typeof T>`
 * on schemas with `.default(...)` (the parsed value is `T`, but the input
 * type is `T | undefined`). Keeping the schema untyped here avoids fighting
 * `exactOptionalPropertyTypes: true` everywhere.
 */
export interface DataActionConfig<A, _R = unknown> {
  readonly id: string;
  readonly kind: ActionKind;
  readonly summary: string;
  readonly args: z.ZodTypeAny;
  readonly result: z.ZodTypeAny;
  /** Cache key used by both Mock and Live runners (must be stable). */
  readonly cacheKey?: (args: A) => readonly (string | number | boolean)[];
  /** Cache prefixes invalidated on success (write/paid only). */
  readonly invalidates?: (args: A) => readonly (readonly (string | number | boolean)[])[];
}

export interface RunOpts {
  readonly signal: AbortSignal;
  readonly forceFresh?: boolean;
}

export interface RunOutcome<R> {
  readonly data: R;
  readonly cached: boolean;
}

export interface DataActionRunner {
  readonly id: 'mock' | 'live';
  run<A, R>(cfg: DataActionConfig<A, R>, args: A, opts: RunOpts): Promise<RunOutcome<R>>;
  invalidate(prefix: readonly (string | number | boolean)[]): void;
  stats(): { readonly entries: number; readonly hits: number; readonly misses: number };
  /**
   * Optional /agent socket bridge — kicks off a backend instruction over
   * the socket gateway and returns the assigned `jobId` so the caller can
   * subscribe to the matching `instruction.agent.delta` frames via
   * `subscribeAgentDelta`.
   *
   * Optional because mock / unit-test runners don't carry a socket
   * client; consumers should null-check before calling.
   */
  readonly invokeBeInstruction?: (
    id: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<{ readonly jobId: string; readonly text: string; readonly ok: boolean }>;
  /**
   * Optional subscription helper paired with `invokeBeInstruction`.
   * Returns an unsubscribe function the caller invokes when the loop
   * has completed (`done` frame seen) or the user cancels.
   */
  readonly subscribeAgentDelta?: (
    jobId: string,
    onFrame: (frame: AgentDeltaFrame) => void,
  ) => () => void;
}

/**
 * Mirror of the BE `InstructionAgentDeltaPayload` discriminated union,
 * narrowed for the FE side. Kept inline here (rather than re-imported
 * from `@quant/shared`) so the terminal package stays free of any
 * dependency on the BE contract — the live-runner glue does the
 * runtime mapping.
 */
export type AgentDeltaFrame =
  | { readonly kind: 'step'; readonly jobId: string; readonly message: string }
  | {
      readonly kind: 'tool_result';
      readonly jobId: string;
      readonly toolId: string;
      readonly ok: boolean;
      readonly summary: string;
    }
  | {
      readonly kind: 'confirm';
      readonly jobId: string;
      readonly correlationId: string;
      readonly toolCalls: readonly {
        readonly id: string;
        readonly args: Readonly<Record<string, unknown>>;
        readonly summary: string;
      }[];
    }
  | { readonly kind: 'text'; readonly jobId: string; readonly chunk: string; readonly done: boolean }
  | {
      readonly kind: 'done';
      readonly jobId: string;
      readonly tokenUsage: { readonly input: number; readonly output: number; readonly total: number };
      readonly cnyCost: number;
      readonly toolCallCount: number;
    };
