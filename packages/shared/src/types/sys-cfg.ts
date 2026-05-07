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
export const SysCfgSchema = z.object({
  theme: ThemeModeSchema,
  slackTargets: z.array(SlackTargetSchema),
  appliedColumns: z.array(z.string()),
});
export type SysCfg = z.infer<typeof SysCfgSchema>;

export const DEFAULT_SYS_CFG: SysCfg = {
  theme: 'light',
  slackTargets: [],
  appliedColumns: [],
};
