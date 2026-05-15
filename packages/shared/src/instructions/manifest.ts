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
 * What does NOT live here:
 *   - Arg zod schemas (per-handler — moving them would require a
 *     larger refactor than this commit's scope; they're handler-local
 *     and validate at the dispatch layer on each side)
 *   - Per-side handlers (FE handlers touch xterm/store, BE handlers
 *     are NestJS-injected — they live in their own modules)
 */

import type { InstructionId } from './id.js';

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
}

const ENTRIES = [
  // ── system ──────────────────────────────────────────────────────────
  { id: 'help', group: 'system', mode: 'sync', supportedOn: ['fe', 'be'], summary: 'Show available instructions and per-id usage' },
  { id: 'ping', group: 'system', mode: 'sync', supportedOn: ['be'], summary: 'Round-trip health check' },
  { id: 'usr', group: 'system', mode: 'sync', supportedOn: ['fe', 'be'], summary: "Show the caller's resolved userId + LLM token usage", imAliases: ['我的', '账号', '我'] },
  { id: 'clear', group: 'ui', mode: 'sync', supportedOn: ['fe'], summary: 'Clear the terminal scrollback' },
  { id: 'cache', group: 'ui', mode: 'sync', supportedOn: ['fe'], summary: 'Inspect / clear local FE caches' },
  { id: 'focus', group: 'ui', mode: 'sync', supportedOn: ['fe'], summary: 'Focus a stock or sector in the workbench' },
  { id: 'update', group: 'system', mode: 'sync', supportedOn: ['fe', 'be'], summary: 'Trigger a data refresh job' },

  // ── market data ─────────────────────────────────────────────────────
  { id: 'stock', group: 'market', mode: 'sync', supportedOn: ['fe', 'be'], summary: 'Search A-share metadata by code, name, or pinyin', imAliases: ['股票'] },

  // ── sectors ─────────────────────────────────────────────────────────
  { id: 'sector', group: 'sector', mode: 'sync', supportedOn: ['fe', 'be'], summary: 'List sectors visible to the caller', imAliases: ['板块'] },
  { id: 'sector.show', group: 'sector', mode: 'sync', supportedOn: ['be'], summary: 'Show one sector with its stock table', imAliases: ['查看板块', '板块详情'] },
  { id: 'sector.publish', group: 'sector', mode: 'sync', supportedOn: ['be'], summary: 'Mark a sector as published' },
  { id: 'sector.unpublish', group: 'sector', mode: 'sync', supportedOn: ['be'], summary: 'Mark a sector as unpublished' },
  { id: 'sector.refresh', group: 'sector', mode: 'async', supportedOn: ['be'], summary: 'Recompute a dynamic sector', costsCredits: true },
  { id: 'sector.rm', group: 'sector', mode: 'sync', supportedOn: ['be'], summary: 'Delete a sector', destructive: true },

  // ── watch ───────────────────────────────────────────────────────────
  { id: 'watch', group: 'watch', mode: 'sync', supportedOn: ['fe', 'be'], summary: 'List watch tasks', aliases: ['watch.list'], imAliases: ['自选'] },
  { id: 'watch.add', group: 'watch', mode: 'sync', supportedOn: ['be'], summary: 'Add a watch task' },
  { id: 'watch.remove', group: 'watch', mode: 'sync', supportedOn: ['be'], summary: 'Remove a watch task', destructive: true },
  { id: 'watch.group', group: 'watch', mode: 'sync', supportedOn: ['be'], summary: 'Manage watch groups' },

  // ── analysis ────────────────────────────────────────────────────────
  { id: 'analyze', group: 'agent', mode: 'async', supportedOn: ['fe', 'be'], summary: 'Sentiment analysis for one stock', costsCredits: true, imAliases: ['情绪分析'] },
  { id: 'analyze.sector', group: 'agent', mode: 'async', supportedOn: ['be'], summary: 'Sentiment analysis aggregated across a sector', costsCredits: true },
  { id: 'ta', group: 'market', mode: 'async', supportedOn: ['fe', 'be'], summary: 'Technical analysis for one stock', costsCredits: true },
  { id: 'ta.sector', group: 'market', mode: 'async', supportedOn: ['be'], summary: 'TA aggregated across a sector', costsCredits: true },

  // ── screening ───────────────────────────────────────────────────────
  { id: 'screen', group: 'market', mode: 'async', supportedOn: ['fe', 'be'], summary: 'Natural-language stock screen', costsCredits: true, imAliases: ['筛选', '选股'] },

  // ── ledger ──────────────────────────────────────────────────────────
  { id: 'ledger', group: 'ledger', mode: 'sync', supportedOn: ['fe', 'be'], summary: 'Show the user trade ledger', imAliases: ['账本'] },
  { id: 'ledger.analyze', group: 'ledger', mode: 'async', supportedOn: ['be'], summary: 'LLM-assisted ledger analysis', costsCredits: true },

  // ── agent ───────────────────────────────────────────────────────────
  { id: 'agent', group: 'agent', mode: 'async', supportedOn: ['fe', 'be'], summary: 'Open-ended agent conversation', costsCredits: true },
  { id: 'agent.confirm', group: 'agent', mode: 'sync', supportedOn: ['be'], summary: 'Confirm a queued agent action card' },
  { id: 'web.search', group: 'agent', mode: 'async', supportedOn: ['be'], summary: 'Hosted-tool web search invoked by the agent', costsCredits: true },

  // ── channel ─────────────────────────────────────────────────────────
  { id: 'channel.echo', group: 'channel', mode: 'sync', supportedOn: ['be'], summary: 'Echo a message back through the inbound channel' },
  { id: 'channel.send', group: 'channel', mode: 'sync', supportedOn: ['be'], summary: 'Send a message to a configured channel' },
] as const satisfies readonly CommandManifestEntry[];

export const COMMAND_MANIFEST: readonly CommandManifestEntry[] = ENTRIES;

export type CommandId = (typeof ENTRIES)[number]['id'];

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
  const expected = new Set(commandsSupportedOn(args.side).map((e) => e.id));
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
