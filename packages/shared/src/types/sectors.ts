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
  /**
   * ISO datetime of the last successful screen run that produced this
   * sector's `codes` / `evidence`. Set on dynamic-sector creation and on
   * refresh; missing on legacy / user sectors.
   */
  lastScreenedAt: z.string().datetime({ offset: true }).optional(),
  /** Internal userId of the original creator. Owner-only edit gate keys off this. */
  createdBy: z.string().min(1),
  /** When true, sector is visible to every user; only the owner may toggle. */
  published: z.boolean().default(false),
  publishedAt: z.string().datetime({ offset: true }).optional(),
});
export type Sector = z.infer<typeof SectorSchema>;

export const SectorsListSchema = z.array(SectorSchema);

/** PUT /api/sectors body: full replace of the sectors list. */
export const SectorsReplaceBodySchema = z.object({
  sectors: SectorsListSchema,
});
export type SectorsReplaceBody = z.infer<typeof SectorsReplaceBodySchema>;

/** POST /api/sectors/:id/publish body. */
export const SectorPublishBodySchema = z.object({
  published: z.boolean(),
});
export type SectorPublishBody = z.infer<typeof SectorPublishBodySchema>;
