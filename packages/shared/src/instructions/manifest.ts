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
 *   - supportedOn (`['fe']` | `['be']` | `['fe', 'be']` — the user's
 *     "explicit declaration of unsupported commands" requirement)
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
  AnalyzeArgsSchema,
  AnalyzeSectorArgsSchema,
  CacheArgsSchema,
  ChannelEchoArgsSchema,
  ChannelSendArgsSchema,
  ClearArgsSchema,
  FocusArgsSchema,
  HelpArgsSchema,
  LedgerAnalyzeArgsSchema,
  LedgerArgsSchema,
  LedgerListResultSchema,
  SectorAckResultSchema,
  PingArgsSchema,
  ScreenArgsSchema,
  SectorArgsSchema,
  SectorPublishArgsSchema,
  SectorRefreshArgsSchema,
  SectorRmArgsSchema,
  SectorShowArgsSchema,
  SectorUnpublishArgsSchema,
  SectorListResultSchema,
  StockArgsSchema,
  StockSearchResultSchema,
  TaArgsSchema,
  TaSectorArgsSchema,
  UpdateArgsSchema,
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

export type CommandSide = 'fe' | 'be';

export type CommandMode = 'sync' | 'async';

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
  /** Where this command is implemented — fail-loud on missing handlers. */
  readonly supportedOn: readonly CommandSide[];
  /** ASCII aliases (e.g. `watch.list` → `watch`). Same on both sides. */
  readonly aliases?: readonly string[];
  /** Free-form aliases (Chinese, emoji) — IM-only. */
  readonly imAliases?: readonly string[];
  readonly summary: string;
  readonly summaryCn?: string;
  /** True when invoking this command spends user credits (LLM calls). */
  readonly costsCredits?: boolean;
  /** True when an irreversible side effect needs explicit IM confirmation. */
  readonly destructive?: boolean;
  /**
   * True when the IM listener should render a paid-confirm card before
   * invoking the handler. Mirror of the legacy `InstructionSpec.requiresImConfirm`
   * — required by the IM gate to know which instructions intercept the
   * first call. Independent of `costsCredits` (a help-only tag); a paid
   * instruction may skip the generic gate when it has its own internal
   * confirm flow (e.g. `/agent`).
   */
  readonly requiresImConfirm?: boolean;
  /**
   * True for handlers that are conditionally registered (e.g. gated on
   * `INSTRUCTION_DEBUG_ENABLED`). The coverage assertion treats them as
   * optional — present-or-absent is fine, but if registered the
   * `supportedOn` declaration must include the side they appear on.
   */
  readonly conditionallyRegistered?: boolean;
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
}

const ENTRIES = [
  // ── system ──────────────────────────────────────────────────────────
  {
    id: 'help',
    group: 'system',
    mode: 'sync',
    supportedOn: ['fe', 'be'],
    summary: 'Show available instructions and per-id usage',
    argsSchema: HelpArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'ping',
    group: 'system',
    mode: 'sync',
    supportedOn: ['be'],
    summary: 'Round-trip health check',
    conditionallyRegistered: true,
    argsSchema: PingArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'usr',
    group: 'system',
    mode: 'sync',
    supportedOn: ['fe', 'be'],
    summary: "Show the caller's resolved userId + LLM token usage",
    imAliases: ['我的', '账号', '我'],
    argsSchema: UsrArgsSchema,
    resultSchema: UsrResultSchema,
  },
  {
    id: 'clear',
    group: 'ui',
    mode: 'sync',
    supportedOn: ['fe'],
    summary: 'Clear the terminal scrollback',
    argsSchema: ClearArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'cache',
    group: 'ui',
    mode: 'sync',
    supportedOn: ['fe'],
    summary: 'Inspect / clear local FE caches',
    argsSchema: CacheArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'focus',
    group: 'ui',
    mode: 'sync',
    supportedOn: ['fe'],
    summary: 'Focus a stock or sector in the workbench',
    argsSchema: FocusArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'update',
    group: 'system',
    mode: 'sync',
    supportedOn: ['fe', 'be'],
    summary: 'Trigger the unified daily scan (meta + kline + blacklist + sectors)',
    argsSchema: UpdateArgsSchema,
    resultSchema: LegacyOutputSchema,
  },

  // ── market data ─────────────────────────────────────────────────────
  {
    id: 'stock',
    group: 'market',
    mode: 'sync',
    supportedOn: ['fe', 'be'],
    summary: 'Search A-share metadata by code, name, or pinyin',
    imAliases: ['股票'],
    argsSchema: StockArgsSchema,
    resultSchema: StockSearchResultSchema,
  },

  // ── sectors ─────────────────────────────────────────────────────────
  {
    id: 'sector',
    group: 'sector',
    mode: 'sync',
    supportedOn: ['fe', 'be'],
    summary: 'List sectors visible to the caller',
    imAliases: ['板块'],
    argsSchema: SectorArgsSchema,
    resultSchema: SectorListResultSchema,
  },
  {
    id: 'sector.show',
    group: 'sector',
    mode: 'sync',
    supportedOn: ['be'],
    summary: 'Show one sector with its stock table',
    imAliases: ['查看板块', '板块详情'],
    argsSchema: SectorShowArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'sector.publish',
    group: 'sector',
    mode: 'sync',
    supportedOn: ['be'],
    summary: 'Mark a sector as published',
    imAliases: ['发布板块', '公开板块'],
    destructive: true,
    argsSchema: SectorPublishArgsSchema,
    resultSchema: SectorAckResultSchema,
  },
  {
    id: 'sector.unpublish',
    group: 'sector',
    mode: 'sync',
    supportedOn: ['be'],
    summary: 'Mark a sector as unpublished',
    imAliases: ['取消发布板块', '下架板块'],
    destructive: true,
    argsSchema: SectorUnpublishArgsSchema,
    resultSchema: SectorAckResultSchema,
  },
  {
    id: 'sector.refresh',
    group: 'sector',
    mode: 'async',
    supportedOn: ['be'],
    summary: 'Recompute a dynamic sector',
    costsCredits: true,
    argsSchema: SectorRefreshArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'sector.rm',
    group: 'sector',
    mode: 'sync',
    supportedOn: ['be'],
    summary: 'Delete a sector',
    destructive: true,
    imAliases: ['删除板块', '移除板块'],
    argsSchema: SectorRmArgsSchema,
    resultSchema: SectorAckResultSchema,
  },

  // ── watch ───────────────────────────────────────────────────────────
  {
    id: 'watch',
    group: 'watch',
    mode: 'sync',
    supportedOn: ['fe', 'be'],
    summary: 'List watch tasks',
    aliases: ['watch.list'],
    imAliases: ['自选'],
    argsSchema: WatchArgsSchema,
    resultSchema: WatchListResultSchema,
  },
  {
    id: 'watch.add',
    group: 'watch',
    mode: 'sync',
    supportedOn: ['be'],
    summary: 'Add a watch task',
    imAliases: ['添加自选', '加自选', '添加预警'],
    argsSchema: WatchAddArgsSchema,
    resultSchema: WatchAddResultSchema,
  },
  {
    id: 'watch.remove',
    group: 'watch',
    mode: 'sync',
    supportedOn: ['be'],
    summary: 'Remove a watch task',
    destructive: true,
    imAliases: ['删除自选', '移除自选', '删除预警'],
    argsSchema: WatchRemoveArgsSchema,
    resultSchema: WatchRemoveResultSchema,
  },
  {
    id: 'watch.group',
    group: 'watch',
    mode: 'sync',
    supportedOn: ['be'],
    summary: 'Manage watch groups',
    imAliases: ['暂停自选', '恢复自选', '盯盘开关'],
    argsSchema: WatchGroupArgsSchema,
    resultSchema: WatchGroupResultSchema,
  },

  // ── analysis ────────────────────────────────────────────────────────
  {
    id: 'analyze',
    group: 'agent',
    mode: 'async',
    supportedOn: ['fe', 'be'],
    summary: 'Sentiment analysis for one stock',
    costsCredits: true,
    requiresImConfirm: true,
    imAliases: ['情绪分析', '舆情', '分析'],
    argsSchema: AnalyzeArgsSchema,
    resultSchema: SentimentSchema,
  },
  {
    id: 'analyze.sector',
    group: 'agent',
    mode: 'async',
    supportedOn: ['be'],
    summary: 'Sentiment analysis aggregated across a sector',
    costsCredits: true,
    argsSchema: AnalyzeSectorArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'ta',
    group: 'market',
    mode: 'async',
    supportedOn: ['fe', 'be'],
    summary: 'Technical analysis for one stock',
    costsCredits: true,
    argsSchema: TaArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'ta.sector',
    group: 'market',
    mode: 'async',
    supportedOn: ['be'],
    summary: 'TA aggregated across a sector',
    costsCredits: true,
    argsSchema: TaSectorArgsSchema,
    resultSchema: LegacyOutputSchema,
  },

  // ── screening ───────────────────────────────────────────────────────
  {
    id: 'screen',
    group: 'market',
    mode: 'async',
    supportedOn: ['fe', 'be'],
    summary: 'Natural-language stock screen',
    costsCredits: true,
    imAliases: ['筛选', '选股'],
    argsSchema: ScreenArgsSchema,
    resultSchema: LegacyOutputSchema,
  },

  // ── ledger ──────────────────────────────────────────────────────────
  {
    id: 'ledger',
    group: 'ledger',
    mode: 'sync',
    supportedOn: ['fe', 'be'],
    summary: 'Show the user trade ledger',
    imAliases: ['账本'],
    argsSchema: LedgerArgsSchema,
    resultSchema: LedgerListResultSchema,
  },
  {
    id: 'ledger.analyze',
    group: 'ledger',
    mode: 'async',
    supportedOn: ['be'],
    summary: 'LLM-assisted ledger analysis',
    costsCredits: true,
    argsSchema: LedgerAnalyzeArgsSchema,
    resultSchema: LegacyOutputSchema,
  },

  // ── agent ───────────────────────────────────────────────────────────
  {
    id: 'agent',
    group: 'agent',
    mode: 'async',
    supportedOn: ['fe', 'be'],
    summary: 'Open-ended agent conversation',
    costsCredits: true,
    argsSchema: AgentArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'agent.confirm',
    group: 'agent',
    mode: 'sync',
    supportedOn: ['be'],
    summary: 'Confirm a queued agent action card',
    argsSchema: AgentConfirmArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'web.search',
    group: 'agent',
    mode: 'async',
    supportedOn: ['be'],
    summary: 'Hosted-tool web search invoked by the agent',
    costsCredits: true,
    argsSchema: WebSearchArgsSchema,
    resultSchema: LegacyOutputSchema,
  },

  // ── channel ─────────────────────────────────────────────────────────
  {
    id: 'channel.echo',
    group: 'channel',
    mode: 'sync',
    supportedOn: ['be'],
    summary: 'Echo a message back through the inbound channel',
    conditionallyRegistered: true,
    argsSchema: ChannelEchoArgsSchema,
    resultSchema: LegacyOutputSchema,
  },
  {
    id: 'channel.send',
    group: 'channel',
    mode: 'sync',
    supportedOn: ['be'],
    summary: 'Send a message to a configured channel',
    conditionallyRegistered: true,
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

export function commandsSupportedOn(side: CommandSide): readonly CommandManifestEntry[] {
  return ENTRIES.filter((e) => (e.supportedOn as readonly CommandSide[]).includes(side));
}

/** Throws when the registered ids don't match the manifest's `supportedOn:side` set. */
export function assertHandlerCoverage(args: {
  readonly side: CommandSide;
  readonly registeredIds: readonly string[];
}): void {
  const expected = new Set(
    commandsSupportedOn(args.side)
      .filter((e) => e.conditionallyRegistered !== true)
      .map((e) => e.id),
  );
  const got = new Set(args.registeredIds);
  const missing: string[] = [];
  for (const id of expected) if (!got.has(id)) missing.push(id);
  const stray: string[] = [];
  for (const id of got) {
    const entry = ENTRY_BY_ID.get(id);
    if (entry === undefined) {
      stray.push(`${id} (not in manifest)`);
      continue;
    }
    if (!(entry.supportedOn as readonly CommandSide[]).includes(args.side)) {
      stray.push(`${id} (manifest says supportedOn=${entry.supportedOn.join(',')})`);
    }
  }
  const errs: string[] = [];
  if (missing.length > 0) errs.push(`missing on ${args.side}: ${missing.join(', ')}`);
  if (stray.length > 0) errs.push(`unexpected on ${args.side}: ${stray.join(', ')}`);
  if (errs.length > 0) {
    throw new Error(`command manifest mismatch — ${errs.join('; ')}`);
  }
}

void (null as InstructionId | null);
