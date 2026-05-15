/**
 * Combined per-user state blob persisted at
 * `data/users/{userId}/user.parquet` (single payload_json row).
 *
 * Why one file? Watch (groups + tasks), ledger entries, and sys-cfg are
 * all small, each user-scoped, and historically lived in 4 separate
 * files (`watch_groups.parquet`, `watch_tasks.parquet`,
 * `ledger.parquet`, `sys-cfg/sys-cfg.json`). One file means one mutex,
 * one atomic write, one self-migration path — and consumers stop having
 * to wonder which file is the source of truth.
 *
 * `llm-ledger` stays separate (`user_llm_ledger.parquet`) because the
 * append-only ledger grows unbounded and we don't want to rewrite the
 * full blob on every LLM call.
 *
 * Migration ordering: when assembling a v1 blob from legacy files, any
 * file that is missing or fails strict validation contributes its
 * `*_DEFAULT` slice. Stricter shapes that pre-date this plan (e.g. the
 * tasks file's nested `{ version, nextIdx, tasks }`) are preserved
 * verbatim inside the blob.
 */

import {
  DEFAULT_SYS_CFG,
  LedgerEntrySchema,
  SysCfgSchema,
  WatchGroupSchema,
  WatchTaskSchema,
  type LedgerEntry,
  type SysCfg,
  type WatchGroup,
  type WatchTask,
} from '@quant/shared';
import { z } from 'zod';

/**
 * Watch tasks live as `{ version: 2, nextIdx, tasks[] }` because the
 * monotonic `nextIdx` counter must outlive deletes. Mirrors the legacy
 * `tasks.json` v2 layout exactly so we don't lose the counter when
 * collapsing files.
 */
export const WatchTaskFileV2Schema = z
  .object({
    version: z.literal(2),
    nextIdx: z.number().int().min(1),
    tasks: z.array(WatchTaskSchema),
  })
  .strict();
export type WatchTaskFileV2 = z.infer<typeof WatchTaskFileV2Schema>;

export const EMPTY_WATCH_TASK_FILE: WatchTaskFileV2 = {
  version: 2,
  nextIdx: 1,
  tasks: [],
};

export const WatchSliceSchema = z
  .object({
    groups: z.array(WatchGroupSchema),
    tasks: WatchTaskFileV2Schema,
  })
  .strict();
export type WatchSlice = z.infer<typeof WatchSliceSchema>;

export const EMPTY_WATCH_SLICE: WatchSlice = {
  groups: [],
  tasks: EMPTY_WATCH_TASK_FILE,
};

export const LedgerSliceSchema = z
  .object({
    entries: z.array(LedgerEntrySchema),
  })
  .strict();
export type LedgerSlice = z.infer<typeof LedgerSliceSchema>;

export const EMPTY_LEDGER_SLICE: LedgerSlice = { entries: [] };

export const USER_BLOB_SCHEMA_VERSION = 1 as const;

export const UserBlobSchema = z
  .object({
    schemaVersion: z.literal(USER_BLOB_SCHEMA_VERSION),
    watch: WatchSliceSchema,
    ledger: LedgerSliceSchema,
    sysCfg: SysCfgSchema,
  })
  .strict();
export type UserBlob = z.infer<typeof UserBlobSchema>;

export const EMPTY_USER_BLOB: UserBlob = {
  schemaVersion: USER_BLOB_SCHEMA_VERSION,
  watch: EMPTY_WATCH_SLICE,
  ledger: EMPTY_LEDGER_SLICE,
  sysCfg: DEFAULT_SYS_CFG,
};

/** Re-exported for facade convenience. */
export type { WatchGroup, WatchTask, LedgerEntry, SysCfg };
