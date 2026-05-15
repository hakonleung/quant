/**
 * Per-instruction argument zod schemas — single source of truth shared
 * by every BE handler and (when the FE adds zod-validated args) the
 * terminal command implementations.
 *
 * Each handler imports the named schema and derives its `Args` type
 * via `z.infer<typeof XxxArgsSchema>`. The manifest in `manifest.ts`
 * references the same schema by import.
 *
 * Common transforms (truthy/falsy bool flags) live here too so every
 * `confirm` / `fresh` field shares one definition rather than each
 * handler re-rolling their own.
 */

import { z } from 'zod';

import { ChannelIdSchema } from '../types/channel.js';
import { AgentHistoryEntrySchema, AGENT_HISTORY_MAX_ENTRIES } from './agent-history.js';

const TRUTHY = new Set(['1', 'true', 'TRUE', 'yes', 'on']);
const FALSY = new Set(['', '0', 'false', 'FALSE', 'no', 'off']);

/**
 * Tolerant bool flag for IM-style command lines (`fresh=true`,
 * `confirm=1`, `notify=no`). Strict zod boolean union doesn't accept
 * the string forms IM users actually type.
 */
export const InstructionBoolFlagSchema = z.union([z.boolean(), z.string()]).transform((v) => {
  if (typeof v === 'boolean') return v;
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  throw new Error(`invalid boolean: ${v}`);
});

/** Same shape as `InstructionBoolFlagSchema` but accepts `undefined` → `false`. */
export const InstructionOptionalBoolFlagSchema = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (TRUTHY.has(v)) return true;
    if (FALSY.has(v)) return false;
    throw new Error(`invalid boolean: ${v}`);
  });

// ── system ──────────────────────────────────────────────────────────────

export const HelpArgsSchema = z.object({ id: z.string().optional() }).strict();
export const PingArgsSchema = z.record(z.string()).default({});
export const UsrArgsSchema = z.object({}).strict();
export const ClearArgsSchema = z.object({}).strict();
export const CacheArgsSchema = z.object({}).strict();
export const FocusArgsSchema = z.object({ id: z.string().min(1).optional() }).strict();
export const UpdateArgsSchema = z
  .object({ target: z.enum(['blacklist']).default('blacklist') })
  .strict();

// ── market ──────────────────────────────────────────────────────────────

export const StockArgsSchema = z
  .object({
    q: z.string().min(1, 'query required').max(64).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

// ── sectors ─────────────────────────────────────────────────────────────

export const SectorArgsSchema = z.object({}).strict();
const sectorIdShape = z.object({
  id: z.string().min(1).describe('Sector id (e.g. s1) or sector name'),
});
export const SectorShowArgsSchema = sectorIdShape.strict();
export const SectorPublishArgsSchema = sectorIdShape.strict();
export const SectorUnpublishArgsSchema = sectorIdShape.strict();
export const SectorRefreshArgsSchema = sectorIdShape.strict();
export const SectorRmArgsSchema = sectorIdShape.strict();

// ── watch ───────────────────────────────────────────────────────────────

export const WatchArgsSchema = z.object({ sub: z.enum(['list']).default('list') }).strict();

export const WatchAddArgsSchema = z
  .object({
    code: z.string().min(1).describe('Stock code, e.g. 600519 for A-shares'),
    market: z.enum(['a', 'hk', 'us']).default('a').describe('Market: a | hk | us'),
    group: z.string().min(1).describe('Watch group name (must already exist)'),
    name: z.string().optional().describe('Human-readable label (defaults to stock name)'),
  })
  .strict();

export const WatchRemoveArgsSchema = z
  .object({
    id: z.string().min(1).describe('Watch task w-index, e.g. w1 or 1'),
  })
  .strict();

export const WatchGroupArgsSchema = z
  .object({
    name: z.string().min(1).describe('Watch group name'),
    state: z
      .enum(['on', 'off', 'pause', 'resume'])
      .describe('on|resume to enable, off|pause to disable'),
  })
  .strict();

// ── analysis ────────────────────────────────────────────────────────────

const codeWith6Digits = z.string().regex(/^\d{6}$/u, 'expected 6-digit code');

export const AnalyzeArgsSchema = z
  .object({
    code: codeWith6Digits,
    fresh: InstructionOptionalBoolFlagSchema,
    windowDays: z.coerce.number().int().min(1).max(30).optional(),
    confirm: InstructionOptionalBoolFlagSchema.describe(
      'IM paid-confirm token, set by the card button',
    ),
  })
  .strict();

export const AnalyzeSectorArgsSchema = z
  .object({
    id: z.string().min(1).describe('Sector id (e.g. s1) or sector name'),
    fresh: InstructionOptionalBoolFlagSchema,
    windowDays: z.coerce.number().int().min(1).max(30).optional(),
    confirm: InstructionOptionalBoolFlagSchema.describe(
      'IM paid-confirm token, set by the card button',
    ),
  })
  .strict();

export const TaArgsSchema = z
  .object({
    code: z.string().min(1).describe('A-share 6-digit stock code, e.g. 600519'),
    fresh: InstructionOptionalBoolFlagSchema.describe('Bypass cache and run fresh LLM analysis'),
    confirm: InstructionBoolFlagSchema.optional().describe(
      'IM paid-confirm token, set by the card button',
    ),
  })
  .strict();

export const TaSectorArgsSchema = z
  .object({
    id: z.string().min(1).describe('Sector id (e.g. s1) or sector name'),
    fresh: InstructionOptionalBoolFlagSchema.describe(
      'Bypass per-stock TA cache and re-run every member',
    ),
    confirm: InstructionBoolFlagSchema.optional().describe(
      'IM paid-confirm token, set by the card button',
    ),
  })
  .strict();

// ── screening ───────────────────────────────────────────────────────────

export const ScreenArgsSchema = z
  .object({
    q: z
      .string()
      .min(1)
      .max(500)
      .describe('Natural-language screening query in Chinese, e.g. "找昨日涨停今天回踩ma5"'),
    asof: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u, 'asof must be YYYY-MM-DD')
      .optional(),
    confirm: InstructionOptionalBoolFlagSchema.describe(
      'IM paid-confirm token, set by the card button',
    ),
  })
  .strict();

// ── ledger ──────────────────────────────────────────────────────────────

export const LedgerArgsSchema = z
  .object({
    sub: z.literal('list').default('list'),
    limit: z.coerce.number().int().min(1).max(50).default(5),
  })
  .strict();

export const LedgerAnalyzeArgsSchema = z
  .object({
    fresh: InstructionOptionalBoolFlagSchema,
  })
  .strict();

// ── agent ───────────────────────────────────────────────────────────────

export const AgentArgsSchema = z
  .object({
    q: z.string().min(1).max(2000),
    confirm: InstructionBoolFlagSchema.optional(),
    context: AgentHistoryEntrySchema.array().max(AGENT_HISTORY_MAX_ENTRIES).optional(),
    maxToolCalls: z.union([z.number(), z.string()]).optional(),
  })
  .strict();
export type AgentArgs = z.infer<typeof AgentArgsSchema>;

export const AgentConfirmArgsSchema = z
  .object({
    correlationId: z.string().min(1),
    approve: InstructionBoolFlagSchema,
  })
  .strict();
export type AgentConfirmArgs = z.infer<typeof AgentConfirmArgsSchema>;

export const WebSearchArgsSchema = z
  .object({
    q: z.string().min(1).max(500).describe('Search query — what to look up on the web'),
    n: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe('Max result summaries to return (default 5)'),
  })
  .strict();

// ── channel ─────────────────────────────────────────────────────────────

export const ChannelEchoArgsSchema = z.record(z.string()).default({});
export const ChannelSendArgsSchema = z
  .object({
    channel: ChannelIdSchema,
    text: z.string().min(1).max(16000),
    target: z.string().min(1).max(256).optional(),
    title: z.string().max(280).optional(),
  })
  .strict();
