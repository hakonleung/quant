/**
 * Cross-process Sector DTOs.
 *
 * Sectors are user-curated baskets (or NL-driven dynamic sets) that
 * persist on the backend as a JSON file. Wire format mirrors the
 * frontend `Sector` interface 1:1 — kept JSON-friendly (no Decimal,
 * no Date) so both sides parse with the same zod schema.
 */

import { z } from 'zod';
import { ScreenPlanAstSchema, RankSpecSchema, UniversePlanAstSchema } from './nl-screen.js';

export const SectorKindSchema = z.enum(['user', 'dynamic']);
export type SectorKind = z.infer<typeof SectorKindSchema>;

export const SectorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: SectorKindSchema,
  count: z.number().int().nonnegative(),
  meta: z.string(),
  chgPct: z.number().nullable(),
  codes: z.array(z.string()).readonly(),
  nl: z.string().optional(),
  evidence: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  screenPlan: ScreenPlanAstSchema.optional(),
  universePlan: UniversePlanAstSchema.nullable().optional(),
  rank: RankSpecSchema.nullable().optional(),
});
export type Sector = z.infer<typeof SectorSchema>;

export const SectorsListSchema = z.array(SectorSchema);

/** PUT /api/sectors body: full replace of the sectors list. */
export const SectorsReplaceBodySchema = z.object({
  sectors: SectorsListSchema,
});
export type SectorsReplaceBody = z.infer<typeof SectorsReplaceBodySchema>;
