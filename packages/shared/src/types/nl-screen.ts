/**
 * Cross-process schema for the NL → DSL → screen pipeline (modules/03,
 * modules/07-frontend.md §4.3.3).
 *
 * The wire payload carries both the matched stocks and the parsed AST,
 * so the UI can render the AST tree alongside the result for the user
 * to compare ("does the parser understand my sentence?").
 *
 * AST shapes mirror the Python `quant_core.domain.types.screen` and
 * `universe_screen` modules. They're recursive — kept narrow with
 * discriminated unions so the renderer can switch on `kind`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// scalar (value) AST
// ---------------------------------------------------------------------------

export const DslFieldSchema = z.object({ kind: z.literal('field'), field: z.string() }).strict();
export type DslField = z.infer<typeof DslFieldSchema>;

/**
 * Universe-side scalar field — resolves against the per-code snapshot
 * (`StockSnapshotDto`) rather than per-bar kline rows. Only valid in
 * positions that are evaluated per-code (rank.metric); using one inside
 * a screen predicate has no per-bar value and evaluates to NA.
 */
export const DslUniverseFieldSchema = z
  .object({ kind: z.literal('universe_field'), field: z.string() })
  .strict();
export type DslUniverseField = z.infer<typeof DslUniverseFieldSchema>;

export const DslConstSchema = z.object({ kind: z.literal('const'), value: z.string() }).strict();
export type DslConst = z.infer<typeof DslConstSchema>;

export const DslAggregateSchema = z
  .object({
    kind: z.literal('agg'),
    agg: z.string(),
    field: z.string(),
    window: z.object({ days: z.number().int().nonnegative() }).strict(),
  })
  .strict();
export type DslAggregate = z.infer<typeof DslAggregateSchema>;

export const DslPeriodReturnSchema = z
  .object({
    kind: z.literal('period_return'),
    window: z.object({ days: z.number().int().nonnegative() }).strict(),
  })
  .strict();
export type DslPeriodReturn = z.infer<typeof DslPeriodReturnSchema>;

export interface DslScale {
  readonly kind: 'scale';
  readonly inner: DslScalar;
  /** stringified Decimal to match `const` wire format */
  readonly factor: string;
}
export type DslScalar =
  | DslField
  | DslUniverseField
  | DslConst
  | DslAggregate
  | DslPeriodReturn
  | DslScale;

export const DslScalarSchema: z.ZodType<DslScalar> = z.lazy(() =>
  z.union([
    DslFieldSchema,
    DslUniverseFieldSchema,
    DslConstSchema,
    DslAggregateSchema,
    DslPeriodReturnSchema,
    z
      .object({
        kind: z.literal('scale'),
        inner: DslScalarSchema,
        factor: z.string(),
      })
      .strict(),
  ]),
);

// ---------------------------------------------------------------------------
// predicate AST (recursive)
// ---------------------------------------------------------------------------

export interface DslCompare {
  readonly kind: 'compare';
  readonly op: string;
  readonly left: DslScalar;
  readonly right: DslScalar;
}
export interface DslLogical {
  readonly kind: 'logical';
  readonly op: 'and' | 'or' | 'not';
  readonly args: readonly DslPredicate[];
}
export interface DslForAll {
  readonly kind: 'for_all';
  readonly window: { readonly days: number };
  readonly predicate: DslPredicate;
}
export interface DslExists {
  readonly kind: 'exists';
  readonly window: { readonly days: number };
  readonly predicate: DslPredicate;
}
export interface DslConsecutive {
  readonly kind: 'consecutive';
  readonly min_len: number;
  readonly predicate: DslPredicate;
}
export type DslPredicate = DslCompare | DslLogical | DslForAll | DslExists | DslConsecutive;

export const DslPredicateSchema: z.ZodType<DslPredicate> = z.lazy(() =>
  z.union([
    z
      .object({
        kind: z.literal('compare'),
        op: z.string(),
        left: DslScalarSchema,
        right: DslScalarSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('logical'),
        op: z.enum(['and', 'or', 'not']),
        args: z.array(DslPredicateSchema),
      })
      .strict(),
    z
      .object({
        kind: z.literal('for_all'),
        window: z.object({ days: z.number().int().nonnegative() }).strict(),
        predicate: DslPredicateSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('exists'),
        window: z.object({ days: z.number().int().nonnegative() }).strict(),
        predicate: DslPredicateSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('consecutive'),
        min_len: z.number().int().positive(),
        predicate: DslPredicateSchema,
      })
      .strict(),
  ]),
);

// ---------------------------------------------------------------------------
// universe AST
// ---------------------------------------------------------------------------

export interface UniverseCompare {
  readonly kind: 'compare';
  readonly op: string;
  readonly left: { readonly kind: 'field'; readonly field: string };
  // `unknown` because the python side emits scalar literals (string,
  // number, boolean, ISO date string) — we don't constrain on the wire.
  readonly right: { readonly kind: 'const'; readonly value?: unknown };
}
export interface UniverseLogical {
  readonly kind: 'logical';
  readonly op: 'and' | 'or' | 'not';
  readonly args: readonly UniverseExpr[];
}
export type UniverseExpr = UniverseCompare | UniverseLogical;

export const UniverseExprSchema: z.ZodType<UniverseExpr> = z.lazy(() =>
  z.union([
    z
      .object({
        kind: z.literal('compare'),
        op: z.string(),
        left: z.object({ kind: z.literal('field'), field: z.string() }).strict(),
        right: z.object({ kind: z.literal('const'), value: z.unknown() }).strict(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('logical'),
        op: z.enum(['and', 'or', 'not']),
        args: z.array(UniverseExprSchema),
      })
      .strict(),
  ]),
);

// ---------------------------------------------------------------------------
// plans + result
// ---------------------------------------------------------------------------

export const ScreenPlanAstSchema = z
  .object({
    asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
    expr: DslPredicateSchema,
  })
  .strict();
export type ScreenPlanAst = z.infer<typeof ScreenPlanAstSchema>;

export const UniversePlanAstSchema = z
  .object({
    asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
    expr: UniverseExprSchema,
  })
  .strict();
export type UniversePlanAst = z.infer<typeof UniversePlanAstSchema>;

export const ScreenMatchSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/, 'expected 6-digit code'),
    /** evaluator-supplied evidence (numbers, strings, arrays, dates as ISO) */
    evidence: z.record(z.unknown()),
  })
  .strict();
export type ScreenMatchView = z.infer<typeof ScreenMatchSchema>;

export const RankSpecSchema = z
  .object({
    metric: DslScalarSchema,
    order: z.enum(['asc', 'desc']),
    topN: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type RankSpecView = z.infer<typeof RankSpecSchema>;

export const NlScreenResultSchema = z
  .object({
    nl: z.string(),
    asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    screenPlan: ScreenPlanAstSchema,
    universePlan: UniversePlanAstSchema.nullable(),
    rank: RankSpecSchema.nullable(),
    matches: z.array(ScreenMatchSchema),
    planSignature: z.string(),
  })
  .strict();
export type NlScreenResult = z.infer<typeof NlScreenResultSchema>;

/**
 * Output of `POST /api/screen/nl2dsl` — translation only, no matches.
 * Decoupled from execution so a downstream caller can present the AST
 * for review/edit before paying the screen-execution cost.
 */
export const NlToDslResultSchema = z
  .object({
    nl: z.string(),
    asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    screenPlan: ScreenPlanAstSchema,
    universePlan: UniversePlanAstSchema.nullable(),
    rank: RankSpecSchema.nullable(),
  })
  .strict();
export type NlToDslResult = z.infer<typeof NlToDslResultSchema>;

/**
 * Output of `POST /api/screen/run` — execute a (possibly edited) AST.
 * Carries no NL/AST echoes since the caller already has them.
 */
export const ScreenRunResultSchema = z
  .object({
    matches: z.array(ScreenMatchSchema),
    planSignature: z.string(),
  })
  .strict();
export type ScreenRunResult = z.infer<typeof ScreenRunResultSchema>;
