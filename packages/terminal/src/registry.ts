/**
 * Command registry for the terminal.
 *
 * `CommandSpec`s are pure values (CLAUDE.md §2.5.1) that describe how to
 * dispatch a parsed argv. The actual side-effect surface (action runner,
 * stores) is injected via `CommandCtx`.
 */

import type { CompletionCandidate } from './completion/completer.js';
import type { StockIndex } from './completion/stock-index.js';
import type { DataActionRunner } from './actions/types.js';
import type { CommitResolution, Event, InteractiveWidgetAny, OutputEntry } from './engine/state.js';
import type { ParsedArgv } from './engine/parse-argv.js';

/* ---------- ctx & stores shim ---------- */

export interface UiStoreShim {
  getFocusCode(): string | null;
  setFocusCode(code: string | null): void;
}

/**
 * Cross-cache invalidation scopes the bridge maps to react-query keys
 * (and any other client-side state stores). Commands and the live
 * runner call `ctx.stores.revalidate(scope)` after a successful write
 * so the rest of the UI reflects the change without a manual refresh.
 *
 *   meta       — stock metadata: list, single rows, industry tags
 *   kline      — kline series: single, bulk, derived snapshots
 *   sentiment  — analyze.one + analyze.many caches
 *   ta         — analyze.ta cache (technical analysis, beta)
 *   sectors    — sector list (zustand-backed)
 *   watch      — watch tasks (mostly SSE-driven; included for symmetry)
 *   all        — everything above
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

export interface CommandStores {
  readonly ui: UiStoreShim;
  /**
   * Optional — host injects a real implementation; when absent (e.g. in
   * unit tests or when a side-effect-free runner is desired) it
   * silently becomes a no-op.
   */
  readonly revalidate?: (scope: RevalidateScope) => void;
}

export interface CommandCtx {
  readonly actions: DataActionRunner;
  readonly stockIndex: StockIndex;
  readonly stores: CommandStores;
  readonly signal: AbortSignal;
}

/* ---------- command spec ---------- */

export type CommandRunOutput =
  | {
      readonly kind: 'text';
      readonly status: OutputEntry['status'];
      readonly tail: { readonly body: string };
    }
  | { readonly kind: 'interactive'; readonly widget: InteractiveWidgetAny }
  /**
   * Bypass the normal `result` event and dispatch one or more engine events
   * directly. Used by `clear`, `clear last N`, etc.
   */
  | { readonly kind: 'engine'; readonly events: readonly Event[] };

export interface CommandSpec {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: string;
  readonly subcommands?: readonly string[];
  /**
   * Per-positional parameter completer. `positionalIdx` is 0-based and
   * skips the command + subcommand tokens.
   */
  readonly complete?: (
    positionalIdx: number,
    fragment: string,
    ctx: CommandCtx,
  ) => readonly CompletionCandidate[];
  readonly run: (argv: ParsedArgv, ctx: CommandCtx) => Promise<CommandRunOutput>;
}

export interface CommandRegistry {
  register(spec: CommandSpec): void;
  resolve(name: string): CommandSpec | undefined;
  list(): readonly CommandSpec[];
  /** Names + aliases — used for top-level completion. */
  allNames(): readonly string[];
  subcommandsOf(name: string): readonly string[];
}

export function createRegistry(): CommandRegistry {
  const byName = new Map<string, CommandSpec>();
  const aliases = new Map<string, string>();
  const order: string[] = [];

  return {
    register(spec) {
      if (byName.has(spec.name)) throw new Error(`duplicate command: ${spec.name}`);
      byName.set(spec.name, spec);
      order.push(spec.name);
      for (const al of spec.aliases ?? []) aliases.set(al, spec.name);
    },
    resolve(name) {
      const real = aliases.get(name) ?? name;
      return byName.get(real);
    },
    list() {
      return order.map((n) => byName.get(n)!).filter((s): s is CommandSpec => s !== undefined);
    },
    allNames() {
      return [...byName.keys(), ...aliases.keys()];
    },
    subcommandsOf(name) {
      const real = aliases.get(name) ?? name;
      return byName.get(real)?.subcommands ?? [];
    },
  };
}

/** Resolution → CommitResolution helpers re-exported for convenience. */
export type { CommitResolution };

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}
