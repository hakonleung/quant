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
}
