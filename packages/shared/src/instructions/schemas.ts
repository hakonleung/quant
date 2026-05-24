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
import { KlineBarSchema } from '../types/eqty.js';
import { LedgerAnalysisSchema } from '../types/ledger.js';
import { SectorSchema } from '../types/sectors.js';
import { StockListRowSchema } from '../types/stock-list.js';
import { StockMetaDtoSchema, StockSnapshotDtoSchema } from '../types/stock-meta.js';
import { TaAnalysisSchema, TaSectorAnalysisSchema } from '../types/ta.js';
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

/**
 * `usr` result — caller identity + LLM ledger snapshot.
 *
 * Strongly-typed data payload (no pre-rendered strings). Per-side renderers
 * (term widget on FE, Feishu card on BE) turn this into the user-facing
 * surface. First instruction to migrate to the new InstructionCenter
 * model where the manifest declares the data contract and renderers are
 * the only side-specific code.
 */
export const UsrIdentitySchema = z
  .object({
    userId: z.string().min(1),
    role: z.enum(['admin', 'user']),
    source: z.string().min(1),
    displayName: z.string().optional(),
    channel: z.string().optional(),
    imId: z.string().optional(),
    mappedFromUserId: z.string().optional(),
    imBootstrap: z.boolean().optional(),
  })
  .strict();
export type UsrIdentity = z.infer<typeof UsrIdentitySchema>;

export const UsrLedgerAggSchema = z
  .object({
    label: z.string().min(1),
    callCount: z.number().int().nonnegative(),
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type UsrLedgerAgg = z.infer<typeof UsrLedgerAggSchema>;

export const UsrLedgerSnapshotSchema = z
  .object({
    today: UsrLedgerAggSchema,
    month: UsrLedgerAggSchema,
    total: UsrLedgerAggSchema,
    byScope: UsrLedgerAggSchema.array(),
    byModel: UsrLedgerAggSchema.array(),
  })
  .strict();
export type UsrLedgerSnapshot = z.infer<typeof UsrLedgerSnapshotSchema>;

export const UsrResultSchema = z
  .object({
    identity: UsrIdentitySchema,
    ledger: UsrLedgerSnapshotSchema.nullable(),
  })
  .strict();
export type UsrResult = z.infer<typeof UsrResultSchema>;
export const ClearArgsSchema = z
  .object({
    /** `last` to drop a count of recent interactions; absent clears all. */
    sub: z.enum(['last']).optional(),
    /** Required when `sub === 'last'`. Coerced from CLI string token. */
    count: z.coerce.number().int().positive().optional(),
  })
  .strict();

/** `/clear` result — describes which scrollback span to drop. */
export const ClearResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('last'), count: z.number().int().positive() }).strict(),
]);
export type ClearResult = z.infer<typeof ClearResultSchema>;

/** `/cache` result — either cache stats (default `sub=stats`) or a clear ack. */
export const CacheResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('stats'),
      entries: z.number().int().nonnegative(),
      hits: z.number().int().nonnegative(),
      misses: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal('cleared') }).strict(),
]);
export type CacheResult = z.infer<typeof CacheResultSchema>;

/**
 * `/focus` result — three outcomes the renderer dispatches into:
 *   - 'pick': open the interactive stock picker (no arg given)
 *   - 'set': set focus to a concrete code (with resolved name)
 *   - 'cleared': drop the focus
 */
export const FocusResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pick') }).strict(),
  z
    .object({
      kind: z.literal('set'),
      code: z.string(),
      name: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal('cleared') }).strict(),
]);
export type FocusResult = z.infer<typeof FocusResultSchema>;
export const CacheArgsSchema = z
  .object({
    /** `stats` (default) prints counters; `clear` invalidates all entries. */
    sub: z.enum(['stats', 'clear']).optional(),
  })
  .strict();
export const FocusArgsSchema = z.object({ id: z.string().min(1).optional() }).strict();
export const UpdateArgsSchema = z.object({}).strict();

/**
 * `/update` result — daily-scan accept ticket. `started=true` means
 * we kicked off a new run; `started=false` means an in-flight scan
 * coalesced this request. Either way `traceId` is the run the client
 * should subscribe to via the `queue.snapshot` socket topic.
 */
export const UpdateResultSchema = z
  .object({
    started: z.boolean(),
    traceId: z.string().min(1),
  })
  .strict();
export type UpdateResult = z.infer<typeof UpdateResultSchema>;

// ── market ──────────────────────────────────────────────────────────────

export const StockArgsSchema = z
  .object({
    q: z.string().min(1, 'query required').max(64).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

/**
 * `/stock` search result — typed rows + the original query so the
 * renderer can echo "no match for X" without re-parsing args.
 */
export const StockSearchResultSchema = z
  .object({
    query: z.string(),
    rows: StockListRowSchema.array(),
  })
  .strict();
export type StockSearchResult = z.infer<typeof StockSearchResultSchema>;

/** Range token accepted by `stock.kline`. */
export const KlineRangeSchema = z.enum(['30D', '90D', '250D']);

/**
 * `/stock.info` — composite info view: meta + latest snapshot +
 * the last 30 daily bars (so the FE can draw a sparkline without a
 * second round-trip).
 */
export const StockInfoArgsSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/u, '6-digit code expected'),
  })
  .strict();
export const StockInfoResultSchema = z
  .object({
    meta: StockMetaDtoSchema,
    snapshot: StockSnapshotDtoSchema.nullable(),
    recentBars: KlineBarSchema.array(),
  })
  .strict();
export type StockInfoResult = z.infer<typeof StockInfoResultSchema>;

/** `/stock.kline` — range-scoped bar list for one code. */
export const StockKlineArgsSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/u, '6-digit code expected'),
    range: KlineRangeSchema.default('30D'),
  })
  .strict();
export const StockKlineResultSchema = z
  .object({
    code: z.string(),
    range: KlineRangeSchema,
    bars: KlineBarSchema.array(),
  })
  .strict();
export type StockKlineResult = z.infer<typeof StockKlineResultSchema>;

// ── sectors ─────────────────────────────────────────────────────────────

export const SectorArgsSchema = z.object({}).strict();

/** One row in the `/sector` list — visible to the caller (own + published). */
export const SectorListRowSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    published: z.boolean(),
    codeCount: z.number().int().nonnegative(),
    createdBy: z.string().min(1),
    isOwn: z.boolean(),
  })
  .strict();
export type SectorListRow = z.infer<typeof SectorListRowSchema>;

export const SectorListResultSchema = z
  .object({
    rows: SectorListRowSchema.array(),
  })
  .strict();
export type SectorListResult = z.infer<typeof SectorListResultSchema>;
const sectorIdShape = z.object({
  id: z.string().min(1).describe('Sector id (e.g. s1) or sector name'),
});
export const SectorShowArgsSchema = sectorIdShape.strict();
export const SectorPublishArgsSchema = sectorIdShape.strict();
export const SectorUnpublishArgsSchema = sectorIdShape.strict();
export const SectorRefreshArgsSchema = sectorIdShape.strict();
export const SectorRmArgsSchema = sectorIdShape.strict();

/**
 * `/sector.show` result — resolved sector identity + the displayed
 * slice of member codes + assembled stock rows (degradable).
 *
 * `evidenceKeys` / `evidenceByCode` are populated only for dynamic
 * sectors; user sectors emit them empty. Renderer joins evidence
 * columns onto each stock row at display time.
 */
export const SectorShowResultSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(['user', 'dynamic']),
    createdBy: z.string().min(1),
    isOwn: z.boolean(),
    published: z.boolean(),
    totalCount: z.number().int().nonnegative(),
    /** Sliced display set (handler caps at MAX_TABLE_ROWS). */
    codes: z.array(z.string()),
    /** Pre-assembled stock rows for `codes`; null when assembly failed. */
    stockRows: StockListRowSchema.array().nullable(),
    /** Sorted evidence column names; empty for user sectors. */
    evidenceKeys: z.array(z.string()),
    /** `{ code: { evidenceKey: formattedString } }` — empty when no evidence. */
    evidenceByCode: z.record(z.string(), z.record(z.string(), z.string())),
  })
  .strict();
export type SectorShowResult = z.infer<typeof SectorShowResultSchema>;

/**
 * Sync-ack result shared by `/sector.publish`, `/sector.unpublish`,
 * `/sector.rm`. Renderer turns the (id, action) pair into a one-line
 * confirmation; `action` is the past-tense verb consumed by the
 * renderer's verb table so the wording stays consistent.
 */
export const SectorAckResultSchema = z
  .object({
    id: z.string().min(1),
    action: z.enum(['published', 'unpublished', 'deleted']),
  })
  .strict();
export type SectorAckResult = z.infer<typeof SectorAckResultSchema>;

/**
 * `/sector.add` — upsert a sector. The legacy FE composes the sector
 * via a multi-step form (name → kind → codes); this is the single
 * upsert pass-through the form's submit step calls.
 */
export const SectorAddArgsSchema = z.object({ sector: SectorSchema }).strict();
export const SectorAddResultSchema = SectorSchema;
export type SectorAddResult = z.infer<typeof SectorAddResultSchema>;

/** `/sector.refresh` result — the persisted sector after the rescreen. */
export const SectorRefreshResultSchema = SectorSchema;
export type SectorRefreshResult = z.infer<typeof SectorRefreshResultSchema>;

// ── watch ───────────────────────────────────────────────────────────────

export const WatchArgsSchema = z.object({ sub: z.enum(['list']).default('list') }).strict();

/**
 * One row in the `/watch` task list — projected to the columns the IM
 * subheader and term widget both render. Decoupled from the canonical
 * `WatchTask` (which carries scheduling internals like intervalSec)
 * because the instruction surface doesn't expose those.
 */
export const WatchListTaskSchema = z
  .object({
    idx: z.number().int().positive(),
    market: z.enum(['a', 'hk', 'us']),
    code: z.string().min(1),
    name: z.string(),
    groupName: z.string().min(1),
    enabled: z.boolean(),
    hitCount: z.number().int().nonnegative(),
  })
  .strict();
export type WatchListTask = z.infer<typeof WatchListTaskSchema>;

export const WatchListResultSchema = z
  .object({
    tasks: WatchListTaskSchema.array(),
    /**
     * A-share stock rows assembled for the tasks' codes — `null` when
     * the upstream snapshot fetch failed or no A-share tasks exist.
     * Renderer falls back to the task-list-only view when null.
     */
    stockRows: StockListRowSchema.array().nullable(),
  })
  .strict();
export type WatchListResult = z.infer<typeof WatchListResultSchema>;

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

/** `/watch.add` ack — the created task summary. */
export const WatchAddResultSchema = z
  .object({
    idx: z.number().int().positive(),
    market: z.enum(['a', 'hk', 'us']),
    code: z.string().min(1),
    name: z.string(),
    groupName: z.string().min(1),
  })
  .strict();
export type WatchAddResult = z.infer<typeof WatchAddResultSchema>;

/** `/watch.remove` ack — the removed task's w-index. */
export const WatchRemoveResultSchema = z
  .object({
    idx: z.number().int().positive(),
  })
  .strict();
export type WatchRemoveResult = z.infer<typeof WatchRemoveResultSchema>;

/** `/watch.group` ack — the resulting enabled state + the verb the user requested. */
export const WatchGroupResultSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean(),
    requestedState: z.enum(['on', 'off', 'pause', 'resume']),
  })
  .strict();
export type WatchGroupResult = z.infer<typeof WatchGroupResultSchema>;

// ── analysis ────────────────────────────────────────────────────────────

/**
 * `/analyze` accepts either a wire-form code (matches `inferMarketFromCode`)
 * or an A-share stock name / pinyin (e.g. `分析 埃科光电`). The cell
 * handler resolves names → codes via `StockMetaService` before the
 * sentiment pipeline runs; non-matching strings produce a clearer
 * "unknown code or name" error at the handler boundary instead of a
 * generic schema rejection that hides the IM ergonomics intent.
 */
export const AnalyzeArgsSchema = z
  .object({
    code: z.string().min(1),
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

/** `/ta <code>` result — typed alias of the existing TaAnalysis. */
export const TaResultSchema = TaAnalysisSchema;
export type TaResult = z.infer<typeof TaResultSchema>;

/**
 * `/ta.sector` result — sector identity + the TaSectorAnalysis payload.
 * Identity is duplicated here (rather than relying on the renderer
 * looking up sectors again) so the data layer stays self-contained.
 */
export const TaSectorResultSchema = z
  .object({
    sectorId: z.string().min(1),
    sectorName: z.string().min(1),
    analysis: TaSectorAnalysisSchema,
  })
  .strict();
export type TaSectorResult = z.infer<typeof TaSectorResultSchema>;

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

/**
 * `/screen` result — the NL screen result + the assembled stock-list
 * rows for the top N matches (same compound pattern as `/watch`).
 *
 * `stockRows` is nullable because `StockListService.assembleRows` can
 * fail (e.g. snapshot upstream down); when it does, the renderer
 * falls back to a plain code list. `displayedCount` is the slice the
 * renderer should treat as visible (handler enforces the top-N cap).
 */
export const ScreenResultSchema = z
  .object({
    nl: z.string(),
    asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    totalMatches: z.number().int().nonnegative(),
    displayedCount: z.number().int().nonnegative(),
    /** Truncated to the displayed slice — what the renderer turns into a table. */
    codes: z.array(z.string()),
    /** Pre-assembled snapshot rows for `codes`; null when assembly failed. */
    stockRows: StockListRowSchema.array().nullable(),
  })
  .strict();
export type ScreenResult = z.infer<typeof ScreenResultSchema>;


// ── ledger ──────────────────────────────────────────────────────────────

export const LedgerArgsSchema = z
  .object({
    sub: z.literal('list').default('list'),
    limit: z.coerce.number().int().min(1).max(50).default(5),
  })
  .strict();

/**
 * One row in the `/ledger` list — pre-projected to the columns the IM
 * and term surfaces both render. Strings (rather than `Decimal`) so the
 * data layer stays serialisable across the FE/BE boundary; the handler
 * is responsible for formatting Decimal → string with consistent
 * precision before returning.
 */
export const LedgerListEntrySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'date must be YYYY-MM-DD'),
    pnlAmount: z.string().min(1),
    closingPosition: z.string().min(1),
    /** Pre-formatted percent like "+1.23%" / "-0.45%" / "0.00%". */
    dailyPctDisplay: z.string().min(1),
  })
  .strict();
export type LedgerListEntry = z.infer<typeof LedgerListEntrySchema>;

export const LedgerListResultSchema = z
  .object({
    /** Total entries in the underlying snapshot (before limit slice). */
    totalCount: z.number().int().nonnegative(),
    /** Rows actually rendered — most-recent first, length ≤ totalCount. */
    entries: LedgerListEntrySchema.array(),
  })
  .strict();
export type LedgerListResult = z.infer<typeof LedgerListResultSchema>;

export const LedgerAnalyzeArgsSchema = z
  .object({
    fresh: InstructionOptionalBoolFlagSchema,
  })
  .strict();

/** `/ledger.analyze` result — typed alias of the existing LedgerAnalysis. */
export const LedgerAnalyzeResultSchema = LedgerAnalysisSchema;
export type LedgerAnalyzeResult = z.infer<typeof LedgerAnalyzeResultSchema>;

/** `/ledger.add` — upsert one entry. */
export const LedgerAddArgsSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'date must be YYYY-MM-DD'),
    pnlAmount: z.string().min(1),
    closingPosition: z.string().min(1).optional(),
  })
  .strict();
export const LedgerAddResultSchema = z
  .object({
    date: z.string(),
    pnlAmount: z.string(),
    closingPosition: z.string().nullable(),
  })
  .strict();
export type LedgerAddResult = z.infer<typeof LedgerAddResultSchema>;

/** `/ledger.remove` — drop one entry by date. */
export const LedgerRemoveArgsSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'date must be YYYY-MM-DD'),
  })
  .strict();
export const LedgerRemoveResultSchema = z
  .object({
    date: z.string(),
  })
  .strict();
export type LedgerRemoveResult = z.infer<typeof LedgerRemoveResultSchema>;

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

/**
 * `/agent` result — the trigger ack. The agent loop itself runs
 * detached; the actual answer streams via the
 * `instruction.agent.delta` socket frames keyed on `jobId`. The
 * confirm-required / forbidden paths surface through the cell's
 * error envelope (`InstructionDispatchError`).
 */
export const AgentResultSchema = z
  .object({
    jobId: z.string().uuid(),
    maxToolCalls: z.number().int().positive(),
  })
  .strict();
export type AgentResult = z.infer<typeof AgentResultSchema>;

/** `/agent.confirm` result — trigger ack for resume. */
export const AgentConfirmResultSchema = z
  .object({
    correlationId: z.string().min(1),
    approve: z.boolean(),
  })
  .strict();
export type AgentConfirmResult = z.infer<typeof AgentConfirmResultSchema>;

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

/**
 * `/web.search` result — the LLM-produced summary text. Carried as a
 * single field (rather than collapsed to `string`) so future
 * structured additions (e.g. `sources: SourceCitation[]`) can land
 * without breaking the renderer / consumers.
 */
export const WebSearchResultSchema = z
  .object({
    text: z.string(),
  })
  .strict();
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

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
