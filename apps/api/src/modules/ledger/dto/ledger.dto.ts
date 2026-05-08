/**
 * Request / param schemas for `LedgerController`. The shape DTOs come
 * from `@quant/shared`; this file only declares the request envelopes
 * (route params, query strings, body bundles) that aren't shared.
 */

import { LedgerEntrySchema } from '@quant/shared';
import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'expected YYYY-MM-DD');

/** `:date` URL param. */
export const LedgerDateParamSchema = z.object({ date: isoDate }).strict();
export type LedgerDateParam = z.infer<typeof LedgerDateParamSchema>;

/** `POST /api/ledger` body — full entry, server enforces uniqueness. */
export const LedgerCreateBodySchema = LedgerEntrySchema;
export type LedgerCreateBody = z.infer<typeof LedgerCreateBodySchema>;

/**
 * `PATCH /api/ledger/:date` body — partial update. We allow all editable
 * fields except `date` (which lives in the URL). Setting
 * `closingPosition: null` clears it; omitting the field leaves it
 * untouched.
 */
export const LedgerPatchBodySchema = z
  .object({
    pnlAmount: z.string().regex(/^-?\d+(\.\d+)?$/u),
    closingPosition: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/u)
      .nullable(),
  })
  .partial()
  .strict();
export type LedgerPatchBody = z.infer<typeof LedgerPatchBodySchema>;

/**
 * `POST /api/ledger/import` body — full set of entries to merge in
 * (imported value wins on date collision). Wrapped in `{ entries }` for
 * forward compatibility with future top-level metadata.
 */
export const LedgerImportBodySchema = z.object({ entries: z.array(LedgerEntrySchema) }).strict();
export type LedgerImportBody = z.infer<typeof LedgerImportBodySchema>;

/** `POST /api/ledger/analyze` body — bypassCache is the only knob. */
export const LedgerAnalyzeBodySchema = z.object({ bypassCache: z.boolean().optional() }).strict();
export type LedgerAnalyzeBody = z.infer<typeof LedgerAnalyzeBodySchema>;
