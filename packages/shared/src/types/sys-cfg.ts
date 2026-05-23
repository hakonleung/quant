/**
 * Cross-process Sys.Cfg DTOs — user settings persisted on the backend
 * (one JSON file). The frontend loads it on boot and writes the full
 * blob on every mutation (replace-on-write keeps the protocol minimal).
 *
 * The user-maintained "blacklist" was removed in 2026-05; an A-share
 * noise blacklist is now computed daily by the backend cron and served
 * via `GET /api/blacklist` (see `docs/modules/12-blacklist.md`).
 */

import { z } from 'zod';

export const ThemeModeSchema = z.enum(['light', 'dark']);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

export const SlackTargetSchema = z.object({
  channel: z.string().min(1),
  webhookUrl: z.string().url(),
});
export type SlackTarget = z.infer<typeof SlackTargetSchema>;

/**
 * Applied columns are stored as opaque strings on the wire — the
 * frontend filters against its own catalog before applying. Validating
 * the literal union here would couple Sys.Cfg to E-1's column catalog,
 * which is owned by the web app.
 */
/**
 * Chart pan direction:
 *   - `natural`  : drag left → reveal content on the left (older bars).
 *                  Cursor and content move in the *same* direction.
 *   - `inverted` : drag left → reveal content on the right (newer bars).
 *                  Cursor moves opposite the panned content.
 */
export const DragDirectionSchema = z.enum(['natural', 'inverted']);
export type DragDirection = z.infer<typeof DragDirectionSchema>;

/**
 * Per-column numeric filter applied to the EQ.LIST sector view. Rows whose
 * column value fails the predicate are dropped; rows whose value is null /
 * undefined / non-numeric are skipped (treated as "no opinion") so partial
 * data sources don't silently empty the table.
 */
export const ColumnFilterOpSchema = z.enum(['>', '>=', '<', '<=', '=', '!=']);
export type ColumnFilterOp = z.infer<typeof ColumnFilterOpSchema>;

export const ColumnFilterSchema = z.object({
  op: ColumnFilterOpSchema,
  value: z.number().finite(),
});
export type ColumnFilter = z.infer<typeof ColumnFilterSchema>;

/**
 * Where column filters apply:
 *   - `all-sectors` : every sector view (default; legacy behaviour).
 *   - `all-only`    : only the synthetic "All" sector — user sectors and
 *                     dynamic / screened sectors are rendered unfiltered.
 */
export const ColumnFilterScopeSchema = z.enum(['all-sectors', 'all-only']);
export type ColumnFilterScope = z.infer<typeof ColumnFilterScopeSchema>;

export const SysCfgSchema = z.object({
  theme: ThemeModeSchema,
  slackTargets: z.array(SlackTargetSchema),
  appliedColumns: z.array(z.string()),
  dragDirection: DragDirectionSchema.default('inverted'),
  /**
   * Map of column-key → numeric filter. Keys are opaque strings (the
   * frontend's `ColumnKey`); validating the literal union here would
   * couple Sys.Cfg to the column catalog, which is owned by the web app.
   */
  columnFilters: z.record(z.string(), ColumnFilterSchema).default({}),
  columnFilterScope: ColumnFilterScopeSchema.default('all-sectors'),
});
export type SysCfg = z.infer<typeof SysCfgSchema>;

export const DEFAULT_SYS_CFG: SysCfg = {
  theme: 'light',
  slackTargets: [],
  appliedColumns: [],
  dragDirection: 'inverted',
  columnFilters: {},
  columnFilterScope: 'all-sectors',
};
