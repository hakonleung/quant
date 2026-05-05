/**
 * Cross-process Sys.Cfg DTOs — user settings + blacklist as a single
 * config blob persisted on the backend (one JSON file). The frontend
 * loads it on boot and writes the full blob on every mutation
 * (replace-on-write keeps the protocol minimal).
 */

import { z } from 'zod';

export const ThemeModeSchema = z.enum(['light', 'dark']);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

export const SlackTargetSchema = z.object({
  channel: z.string().min(1),
  webhookUrl: z.string().url(),
});
export type SlackTarget = z.infer<typeof SlackTargetSchema>;

export const BlacklistEntrySchema = z.object({
  code: z.string().min(1),
  name: z.string(),
  /** ISO date the entry was added. */
  addedAt: z.string(),
  note: z.string(),
});
export type BlacklistEntry = z.infer<typeof BlacklistEntrySchema>;

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
  blacklist: z.array(BlacklistEntrySchema),
});
export type SysCfg = z.infer<typeof SysCfgSchema>;

export const DEFAULT_SYS_CFG: SysCfg = {
  theme: 'light',
  slackTargets: [],
  appliedColumns: [],
  blacklist: [],
};
