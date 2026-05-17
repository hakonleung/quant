/**
 * Cross-process command manifest — single declarative source of truth
 * for every instruction the system knows about. Both the NestJS
 * `InstructionRegistry` and the FE xterm registry assert against this
 * map at startup so that "command X is supported on FE/BE" is a
 * compile-time + runtime contract instead of a registration accident.
 *
 * What lives here:
 *   - Stable instruction id (matches `instructionId('xxx')` on BE +
 *     `CommandSpec.name` on FE)
 *   - aliases / imAliases (Chinese voice triggers)
 *   - mode (`sync` / `async` — long-running tasks ack queued on IM)
 *   - group (used by /help to bucket commands)
 *   - summary / summaryCn for tab completion + IM help
 *
 * Arg zod schemas live in the sibling `schemas.ts` file. Each
 * manifest entry references the named schema by import; handlers
 * derive their `Args` type via `z.infer<typeof XxxArgsSchema>` from
 * the same source. The split keeps schema definitions next to each
 * other (easier to review for shape drift) without bloating this
 * manifest file with zod type expressions.
 *
 * What does NOT live here:
 *   - Per-side handlers (FE handlers touch xterm/store, BE handlers
 *     are NestJS-injected — they live in their own modules).
 */

import type { z } from 'zod';

import { SentimentSchema } from '../types/eqty.js';
import type { InstructionId } from './id.js';
import { InstructionOutputSchema } from './result.js';
import {
  AgentArgsSchema,
  AgentConfirmArgsSchema,
  AgentConfirmResultSchema,
  AgentResultSchema,
  AnalyzeArgsSchema,
  AnalyzeSectorArgsSchema,
  CacheArgsSchema,
  CacheResultSchema,
  ChannelEchoArgsSchema,
  ChannelSendArgsSchema,
  ClearArgsSchema,
  ClearResultSchema,
  FocusArgsSchema,
  FocusResultSchema,
  HelpArgsSchema,
  LedgerAddArgsSchema,
  LedgerAddResultSchema,
  LedgerAnalyzeArgsSchema,
  LedgerAnalyzeResultSchema,
  LedgerArgsSchema,
  LedgerListResultSchema,
  LedgerRemoveArgsSchema,
  LedgerRemoveResultSchema,
  SectorAckResultSchema,
  SectorAddArgsSchema,
  SectorAddResultSchema,
  SectorRefreshResultSchema,
  PingArgsSchema,
  ScreenArgsSchema,
  ScreenResultSchema,
  SectorArgsSchema,
  SectorPublishArgsSchema,
  SectorRefreshArgsSchema,
  SectorRmArgsSchema,
  SectorShowArgsSchema,
  SectorUnpublishArgsSchema,
  SectorListResultSchema,
  SectorShowResultSchema,
  StockArgsSchema,
  StockInfoArgsSchema,
  StockInfoResultSchema,
  StockKlineArgsSchema,
  StockKlineResultSchema,
  StockSearchResultSchema,
  TaArgsSchema,
  TaResultSchema,
  TaSectorArgsSchema,
  TaSectorResultSchema,
  UpdateArgsSchema,
  UpdateResultSchema,
  UsrArgsSchema,
  UsrResultSchema,
  WatchAddArgsSchema,
  WatchAddResultSchema,
  WatchArgsSchema,
  WatchGroupArgsSchema,
  WatchGroupResultSchema,
  WatchListResultSchema,
  WatchRemoveArgsSchema,
  WatchRemoveResultSchema,
  WebSearchArgsSchema,
  WebSearchResultSchema,
} from './schemas.js';

/**
 * Default result schema for instructions still on the legacy
 * `okResultWithMeta(text, meta)` shape. New / migrated instructions
 * override this with a strongly-typed payload schema (e.g.
 * `UsrResultSchema`) so the InstructionCenter can derive per-id
 * result types and enforce FE/BE renderer parity at compile time.
 *
 * Phase-2 migration goal: every entry has a real `resultSchema` and
 * this default disappears.
 */
const LegacyOutputSchema = InstructionOutputSchema;

export type CommandMode = 'sync' | 'async';

/**
 * Named FE cache scopes invalidated by an instruction's success path.
 * Declared on the manifest entry so the FE shell (after a successful
 * `feCenter.dispatch(...)`) can fan out one or more `revalidate(scope)`
 * calls without each cell having to remember.
 *
 *   - meta       stock metadata: list, single rows, industry tags
 *   - kline      kline series: single, bulk, derived snapshots
 *   - sentiment  analyze.one + analyze.many caches
 *   - ta         analyze.ta cache (technical analysis)
 *   - sectors    sector list (zustand-backed)
 *   - watch      watch tasks (mostly SSE-driven; included for symmetry)
 *   - ledger     ledger entries + analysis
 *   - all        every scope above
 */
export type RevalidateScope =
  | 'meta'
  | 'kline'
  | 'sentiment'
  | 'ta'
  | 'sectors'
  | 'watch'
  | 'ledger'
  | 'all';

export type CommandGroup =
  | 'system'
  | 'market'
  | 'sector'
  | 'watch'
  | 'ledger'
  | 'agent'
  | 'channel'
  | 'ui';

export interface CommandManifestEntry {
  /** Stable id — matches `instructionId('xxx')` on BE. */
  readonly id: string;
  /** Bucket the /help renderer groups under. */
  readonly group: CommandGroup;
  /** Sync results land in the same response; async returns a queued ack. */
  readonly mode: CommandMode;
  readonly summary: string;
  readonly summaryCn?: string;
  /**
   * Alternate tokens accepted by the dispatcher — covers both ASCII
   * aliases (`watch.list` → `watch`) and free-form / Chinese aliases
   * (`'账本'` → `ledger`). The parser's `knownIds()` map treats them
   * uniformly; the old ASCII-vs-IM split had no consumer.
   */
  readonly aliases?: readonly string[];
  /**
   * Why the instruction needs a double-confirm surface:
   *   - `'llm'`: triggers a paid external LLM call (help badges `[$]`,
   *     agent loop gate fires per tool call).
   *   - `'destructive'`: irreversible side effect (help badges `[!]`,
   *     agent loop gate fires per tool call).
   *
   * Orthogonal to `imGate`: this captures *why*, `imGate` captures
   * *how the IM surface confirms* (some destructive ops let the FE
   * confirm without an IM card; some paid flows have handler-internal
   * confirm and skip the generic gate too — `/agent` is the latter).
   *
   * Empty means no special confirm: zero LLM cost, fully reversible.
   */
  readonly doubleConfirm?: 'llm' | 'destructive';
  /**
   * When `true`, the IM listener interposes the generic paid-confirm
   * card before dispatching. Independent of `doubleConfirm` so callers
   * can opt out (e.g. `/agent` has its own internal confirm flow).
   * Cells expose an optional `peek` hook to skip the card on cache
   * hits — see `InstructionCell.peek` in `center.ts`.
   */
  readonly imGate?: boolean;
  /**
   * Single source of truth for the BE handler's argument shape.
   * Handlers `import { XxxArgsSchema } from '@quant/shared'` and
   * derive `type Args = z.infer<typeof XxxArgsSchema>` from the same
   * binding the manifest references — guaranteed in lockstep.
   */
  readonly argsSchema?: z.ZodTypeAny;
  /**
   * Single source of truth for the handler's return payload — consumed
   * by the new `InstructionCenter` (see `center.ts`) to derive
   * `ResultOf<I>` and force FE/BE handlers + renderers into structural
   * lockstep. Entries still using the legacy `{text, meta?}` envelope
   * point at `LegacyOutputSchema`; migrated entries point at their own
   * strongly-typed schema (e.g. `UsrResultSchema`).
   */
  readonly resultSchema: z.ZodTypeAny;
  /**
   * Map positional tokens to named arg fields, in order. `tokenize`'s
   * positional array is consumed left-to-right; index 0 becomes the
   * first listed field, index 1 the second, etc. Trailing positionals
   * are ignored (or zod errors if the field is required).
   *
   * Example: `positional: ['code']` lets `focus 600519` reach the
   * handler as `{ code: '600519' }`; the user can equivalently write
   * `focus --code=600519`. Schemas use `.coerce` where the target
   * type is non-string.
   */
  readonly positional?: readonly string[];
  /**
   * FE cache scopes invalidated after a successful dispatch. The FE
   * shell fires `revalidate(scope)` for each entry once `feCenter`
   * returns ok. BE ignores this field. Reads should leave it empty;
   * writes list every scope whose data the instruction touches. Use
   * `['all']` only when the change is broad enough that fine-grained
   * scopes don't help.
   */
  readonly revalidate?: readonly RevalidateScope[];
  /**
   * Concrete invocation examples shown by `/help <id>`. Each entry is a
   * full command line (without the leading slash), e.g. `'sector.show s1'`
   * or `'watch.add code=600519 trigger=price>=30'`. Falls back to a
   * positional-derived stub (`id <id>`) when omitted.
   */
  readonly examples?: readonly string[];
  /**
   * Free-form long-form help shown after the summary by `/help <id>`.
   * Use to document non-obvious semantics — e.g. "invoked from the
   * sector form, not the terminal", argv quirks, post-conditions.
   */
  readonly help?: string;
}

const ENTRIES = [
  // ── system ──────────────────────────────────────────────────────────
  {
    id: 'help',
    group: 'system',
    mode: 'sync',
    summary: 'Show available instructions and per-id usage',
    positional: ['id'],
    examples: ['help', 'help sector.show', 'help id=ledger'],
    argsSchema: HelpArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'ping',
    group: 'system',
    mode: 'sync',
    summary: 'Round-trip latency probe; echoes args + traceId. (debug)',
    examples: ['ping', 'ping foo=bar'],
    help: 'Process-level health check. Different from `channel.echo`, which is the IM-channel round-trip that proves messages can be routed back through the active channel adapter.',
    argsSchema: PingArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'usr',
    group: 'system',
    mode: 'sync',
    summary: "Show the caller's resolved userId + LLM token usage",
    aliases: ['我的', '账号', '我'],
    examples: ['usr', '我', '账号'],
    argsSchema: UsrArgsSchema,
    resultSchema: UsrResultSchema,
  },
  {
    id: 'clear',
    group: 'ui',
    mode: 'sync',
    summary: 'Clear the terminal scrollback',
    aliases: ['cls'],
    positional: ['sub', 'count'],
    examples: ['clear', 'clear last 3', 'clear sub=last count=5', 'cls'],
    argsSchema: ClearArgsSchema,
    resultSchema: ClearResultSchema,
  },
  {
    id: 'cache',
    group: 'ui',
    mode: 'sync',
    summary: 'Inspect / clear local FE caches',
    aliases: [':cache'],
    positional: ['sub'],
    examples: ['cache', 'cache stats', 'cache clear', 'cache sub=clear'],
    argsSchema: CacheArgsSchema,
    resultSchema: CacheResultSchema,
  },
  {
    id: 'focus',
    group: 'ui',
    mode: 'sync',
    summary: 'Focus a stock or sector in the workbench',
    positional: ['id'],
    examples: ['focus', 'focus 600519', 'focus id=s1', 'focus 平安银行'],
    argsSchema: FocusArgsSchema,
    resultSchema: FocusResultSchema,
  },
  {
    id: 'update',
    group: 'system',
    mode: 'sync',
    summary: 'Trigger the unified daily scan (meta + kline + blacklist + sectors)',
    aliases: ['更新'],
    doubleConfirm: 'destructive',
    revalidate: ['all'],
    examples: ['update', '更新'],
    argsSchema: UpdateArgsSchema,
    resultSchema: UpdateResultSchema,
  },

  // ── market data ─────────────────────────────────────────────────────
  {
    id: 'stock',
    group: 'market',
    mode: 'sync',
    summary: 'Search A-share metadata by code, name, or pinyin',
    aliases: ['股票'],
    positional: ['q'],
    examples: ['stock 茅台', 'stock 600519', 'stock q=平安 limit=20', '股票 mt'],
    argsSchema: StockArgsSchema,
    resultSchema: StockSearchResultSchema,
  },
  {
    id: 'stock.info',
    group: 'market',
    mode: 'sync',
    summary: 'Composite info view (meta + snapshot + recent bars) for one code',
    positional: ['code'],
    examples: ['stock.info 600519', 'stock info 600519', 'stock.info code=600519'],
    argsSchema: StockInfoArgsSchema,
    resultSchema: StockInfoResultSchema,
  },
  {
    id: 'stock.kline',
    group: 'market',
    mode: 'sync',
    summary: 'Range-scoped kline bars for one code',
    positional: ['code', 'range'],
    examples: [
      'stock.kline 600519',
      'stock.kline 600519 90D',
      'stock kline 600519 250D',
      'stock.kline code=600519 range=90D',
    ],
    help: '`range` is one of `30D` / `90D` / `250D` (default `30D`).',
    argsSchema: StockKlineArgsSchema,
    resultSchema: StockKlineResultSchema,
  },

  // ── sectors ─────────────────────────────────────────────────────────
  {
    id: 'sector',
    group: 'sector',
    mode: 'sync',
    summary: 'List sectors visible to the caller',
    aliases: ['板块'],
    examples: ['sector'],
    argsSchema: SectorArgsSchema,
    resultSchema: SectorListResultSchema,
  },
  {
    id: 'sector.show',
    group: 'sector',
    mode: 'sync',
    summary: 'Show one sector with its stock table',
    aliases: ['查看板块', '板块详情'],
    positional: ['id'],
    examples: ['sector.show s1', 'sector show s1', 'sector.show id=s1'],
    help: 'Resolve a sector by `s{n}` id or by name; renders the member stock table plus evidence columns for dynamic sectors.',
    argsSchema: SectorShowArgsSchema,
    resultSchema: SectorShowResultSchema,
  },
  {
    id: 'sector.publish',
    group: 'sector',
    mode: 'sync',
    summary: 'Mark a sector as published',
    aliases: ['发布板块', '公开板块'],
    doubleConfirm: 'destructive',
    revalidate: ['sectors'],
    positional: ['id'],
    examples: ['sector.publish s1'],
    help: 'Owner-only. Makes the sector visible to every user.',
    argsSchema: SectorPublishArgsSchema,
    resultSchema: SectorAckResultSchema,
  },
  {
    id: 'sector.unpublish',
    group: 'sector',
    mode: 'sync',
    summary: 'Mark a sector as unpublished',
    aliases: ['取消发布板块', '下架板块'],
    doubleConfirm: 'destructive',
    revalidate: ['sectors'],
    positional: ['id'],
    examples: ['sector.unpublish s1'],
    help: 'Owner-only. Hides the sector from other users without deleting it.',
    argsSchema: SectorUnpublishArgsSchema,
    resultSchema: SectorAckResultSchema,
  },
  {
    id: 'sector.refresh',
    group: 'sector',
    mode: 'async',
    summary: 'Recompute a dynamic sector',
    doubleConfirm: 'llm',
    revalidate: ['sectors'],
    positional: ['id'],
    examples: ['sector.refresh s1'],
    help: 'Re-runs the saved screen plan for a dynamic sector. Triggers a paid LLM call when the plan needs re-planning.',
    argsSchema: SectorRefreshArgsSchema,
    resultSchema: SectorRefreshResultSchema,
  },
  {
    id: 'sector.add',
    group: 'sector',
    mode: 'sync',
    summary: 'Add or update a sector',
    revalidate: ['sectors'],
    help: 'Not typable from the terminal — args take a full structured `sector` object. Use the 板块 / SEC.LIST pane form (or call programmatically) to create or edit a sector.',
    argsSchema: SectorAddArgsSchema,
    resultSchema: SectorAddResultSchema,
  },
  {
    id: 'sector.rm',
    group: 'sector',
    mode: 'sync',
    summary: 'Delete a sector',
    aliases: ['删除板块', '移除板块'],
    doubleConfirm: 'destructive',
    revalidate: ['sectors'],
    positional: ['id'],
    examples: ['sector.rm s1'],
    help: 'Owner-only. Permanently removes the sector record.',
    argsSchema: SectorRmArgsSchema,
    resultSchema: SectorAckResultSchema,
  },

  // ── watch ───────────────────────────────────────────────────────────
  {
    id: 'watch',
    group: 'watch',
    mode: 'sync',
    summary: 'List watch tasks',
    aliases: ['watch.list', '自选'],
    positional: ['sub'],
    examples: ['watch', 'watch list', 'watch sub=list', '自选'],
    argsSchema: WatchArgsSchema,
    resultSchema: WatchListResultSchema,
  },
  {
    id: 'watch.add',
    group: 'watch',
    mode: 'sync',
    summary: 'Add a watch task',
    aliases: ['添加自选', '加自选', '添加预警'],
    revalidate: ['watch'],
    positional: ['code', 'group'],
    examples: [
      'watch.add 600519 主仓',
      'watch.add code=600519 market=a group=主仓',
      'watch.add code=AAPL market=us group=美股 name=Apple',
      '添加自选 600519 主仓',
    ],
    help: '`market` defaults to `a` (A-shares). `group` must already exist — use `watch.group` to manage groups.',
    argsSchema: WatchAddArgsSchema,
    resultSchema: WatchAddResultSchema,
  },
  {
    id: 'watch.remove',
    group: 'watch',
    mode: 'sync',
    summary: 'Remove a watch task',
    aliases: ['删除自选', '移除自选', '删除预警'],
    doubleConfirm: 'destructive',
    revalidate: ['watch'],
    positional: ['id'],
    examples: ['watch.remove w1', 'watch.remove 1', 'watch.remove id=w1', '删除自选 w1'],
    argsSchema: WatchRemoveArgsSchema,
    resultSchema: WatchRemoveResultSchema,
  },
  {
    id: 'watch.group',
    group: 'watch',
    mode: 'sync',
    summary: 'Manage watch groups (toggle enabled state)',
    aliases: ['暂停自选', '恢复自选', '盯盘开关'],
    revalidate: ['watch'],
    positional: ['name', 'state'],
    examples: [
      'watch.group 主仓 pause',
      'watch.group 主仓 resume',
      'watch.group name=主仓 state=off',
      '盯盘开关 主仓 on',
    ],
    help: '`state` is one of `on` / `off` / `pause` / `resume`. `on`/`resume` enable; `off`/`pause` disable.',
    argsSchema: WatchGroupArgsSchema,
    resultSchema: WatchGroupResultSchema,
  },

  // ── analysis ────────────────────────────────────────────────────────
  {
    id: 'analyze',
    group: 'agent',
    mode: 'async',
    summary: 'Sentiment analysis for one stock',
    aliases: ['情绪分析', '舆情', '分析'],
    doubleConfirm: 'llm',
    imGate: true,
    revalidate: ['sentiment'],
    positional: ['code'],
    examples: [
      'analyze 300632',
      'analyze 300632 fresh=1',
      'analyze code=300632 windowDays=14',
      '分析 300632',
    ],
    help: '`fresh=1` bypasses cache. `windowDays` (1–30) sets the news-recency window; defaults to the cached value.',
    argsSchema: AnalyzeArgsSchema,
    resultSchema: SentimentSchema,
  },
  {
    id: 'analyze.sector',
    group: 'agent',
    mode: 'async',
    summary: 'Sentiment analysis aggregated across a sector',
    doubleConfirm: 'llm',
    revalidate: ['sentiment'],
    positional: ['id'],
    examples: [
      'analyze.sector s1',
      'analyze.sector 新东西',
      'analyze.sector id=s1 fresh=1 windowDays=14',
    ],
    argsSchema: AnalyzeSectorArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'ta',
    group: 'market',
    mode: 'async',
    summary: 'Technical analysis for one stock',
    aliases: ['技术', '走势', '技分'],
    doubleConfirm: 'llm',
    imGate: true,
    revalidate: ['ta'],
    positional: ['code'],
    examples: ['ta 600519', 'ta 600519 fresh=1', 'ta code=600519', '技术 600519'],
    argsSchema: TaArgsSchema,
    resultSchema: TaResultSchema,
  },
  {
    id: 'ta.sector',
    group: 'market',
    mode: 'async',
    summary: 'TA aggregated across a sector',
    aliases: ['板块技术', '板块走势', '板块技分'],
    doubleConfirm: 'llm',
    imGate: true,
    revalidate: ['ta'],
    positional: ['id'],
    examples: ['ta.sector s1', 'ta.sector 新东西 fresh=1', 'ta.sector id=s1', '板块技术 s1'],
    argsSchema: TaSectorArgsSchema,
    resultSchema: TaSectorResultSchema,
  },

  // ── screening ───────────────────────────────────────────────────────
  {
    id: 'screen',
    group: 'market',
    mode: 'async',
    summary: 'Natural-language stock screen',
    aliases: ['筛选', '选股'],
    doubleConfirm: 'llm',
    imGate: true,
    positional: ['q'],
    examples: [
      'screen "找昨日涨停今天回踩ma5"',
      'screen q="近10日突破90日新高" asof=2026-05-17',
      '选股 "MACD 金叉且换手>3%"',
    ],
    help: '`q` is the natural-language query (quote when it contains spaces). `asof` is optional YYYY-MM-DD; defaults to latest trading day.',
    argsSchema: ScreenArgsSchema,
    resultSchema: ScreenResultSchema,
  },

  // ── ledger ──────────────────────────────────────────────────────────
  {
    id: 'ledger',
    group: 'ledger',
    mode: 'sync',
    summary: 'Show the user trade ledger',
    aliases: ['账本'],
    examples: ['ledger', 'ledger limit=20', '账本'],
    argsSchema: LedgerArgsSchema,
    resultSchema: LedgerListResultSchema,
  },
  {
    id: 'ledger.analyze',
    group: 'ledger',
    mode: 'async',
    summary: 'LLM-assisted ledger analysis',
    aliases: ['复盘', '账本复盘', '账本分析'],
    doubleConfirm: 'llm',
    revalidate: ['ledger'],
    examples: ['ledger.analyze', 'ledger.analyze fresh=1', '复盘'],
    argsSchema: LedgerAnalyzeArgsSchema,
    resultSchema: LedgerAnalyzeResultSchema,
  },
  {
    id: 'ledger.add',
    group: 'ledger',
    mode: 'sync',
    summary: 'Add or upsert one ledger entry',
    positional: ['date', 'pnlAmount', 'closingPosition'],
    revalidate: ['ledger'],
    examples: [
      'ledger.add 2026-05-17 +1234.50 50000',
      'ledger.add 2026-05-17 -500.00',
      'ledger.add date=2026-05-17 pnlAmount=+1234.50 closingPosition=50000',
    ],
    help: '`date` is YYYY-MM-DD. `pnlAmount` keeps sign (`+` / `-`). `closingPosition` is optional.',
    argsSchema: LedgerAddArgsSchema,
    resultSchema: LedgerAddResultSchema,
  },
  {
    id: 'ledger.remove',
    group: 'ledger',
    mode: 'sync',
    summary: 'Remove one ledger entry by date',
    aliases: ['ledger.rm'],
    doubleConfirm: 'destructive',
    positional: ['date'],
    revalidate: ['ledger'],
    examples: ['ledger.remove 2026-05-17', 'ledger.rm 2026-05-17', 'ledger.remove date=2026-05-17'],
    argsSchema: LedgerRemoveArgsSchema,
    resultSchema: LedgerRemoveResultSchema,
  },

  // ── agent ───────────────────────────────────────────────────────────
  {
    id: 'agent',
    group: 'agent',
    // Trigger ack is sync (the small "▶ started" line). The actual agent
    // loop runs detached and streams output via `instruction.agent.delta`
    // socket frames.
    mode: 'sync',
    summary: 'Open-ended agent conversation',
    aliases: ['助手'],
    doubleConfirm: 'llm',
    positional: ['q'],
    examples: [
      'agent "帮我分析下今天大盘"',
      'agent q="梳理新能源板块" maxToolCalls=10',
      '助手 "看看 300632"',
    ],
    argsSchema: AgentArgsSchema,
    resultSchema: AgentResultSchema,
  },
  {
    id: 'agent.confirm',
    group: 'agent',
    mode: 'sync',
    summary: 'Confirm a queued agent action card',
    positional: ['correlationId', 'approve'],
    examples: [
      'agent.confirm 6f9d-... 1',
      'agent.confirm correlationId=6f9d-... approve=0',
    ],
    help: 'Usually invoked by the IM card buttons, not by hand. `approve=1` resumes the agent; `approve=0` cancels it.',
    argsSchema: AgentConfirmArgsSchema,
    resultSchema: AgentConfirmResultSchema,
  },
  {
    id: 'web.search',
    group: 'agent',
    mode: 'async',
    summary: 'Hosted-tool web search invoked by the agent',
    aliases: ['网搜', '联网搜索', '搜网'],
    doubleConfirm: 'llm',
    positional: ['q'],
    examples: [
      'web.search "claude code release notes"',
      'web.search q="A股最新政策" n=3',
      '网搜 "新能源板块新闻"',
    ],
    argsSchema: WebSearchArgsSchema,
    resultSchema: WebSearchResultSchema,
  },

  // ── channel ─────────────────────────────────────────────────────────
  {
    id: 'channel.echo',
    group: 'channel',
    mode: 'sync',
    summary: 'Echo args back through the same IM channel. (debug)',
    examples: ['channel.echo', 'channel.echo foo=bar baz=qux'],
    help: 'Proves the IM round-trip: takes whatever k=v pairs you pass and echoes them back through the active channel adapter. Use `ping` for a plain process-level latency check that does not touch the channel layer.',
    argsSchema: ChannelEchoArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'channel.send',
    group: 'channel',
    mode: 'sync',
    summary: 'Send a message to a configured channel',
    positional: ['channel', 'text'],
    examples: [
      'channel.send feishu "hello world"',
      'channel.send channel=feishu text="alert: ma5 break" target=user123 title=Alert',
    ],
    help: '`channel` is the registered channel id (e.g. `feishu`). `target` / `title` are optional routing hints understood by the channel adapter.',
    argsSchema: ChannelSendArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
] as const satisfies readonly CommandManifestEntry[];

export const COMMAND_MANIFEST: readonly CommandManifestEntry[] = ENTRIES;

export type CommandId = (typeof ENTRIES)[number]['id'];

/**
 * Indexed manifest — id → entry, with each entry retaining its literal
 * argsSchema / resultSchema types via the source tuple. This is the
 * surface `InstructionCenter` consumes to derive `ArgsOf<I>` and
 * `ResultOf<I>` per id at compile time.
 *
 * We build it via reduce (typed cast on the result) because
 * `Object.fromEntries` widens the value type back to the base entry,
 * losing per-id schema specificity.
 */
type EntriesById<T extends readonly { readonly id: string }[]> = {
  readonly [E in T[number] as E['id']]: E;
};

export type ManifestById = EntriesById<typeof ENTRIES>;

export const INSTRUCTION_MANIFEST: ManifestById = ENTRIES.reduce(
  (acc, entry) => {
    (acc as Record<string, CommandManifestEntry>)[entry.id] = entry;
    return acc;
  },
  {} as Record<string, CommandManifestEntry>,
) as ManifestById;

const ENTRY_BY_ID: ReadonlyMap<string, CommandManifestEntry> = new Map(
  ENTRIES.map((e) => [e.id, e]),
);

export function getCommandManifestEntry(id: string): CommandManifestEntry | undefined {
  return ENTRY_BY_ID.get(id);
}

void (null as InstructionId | null);
