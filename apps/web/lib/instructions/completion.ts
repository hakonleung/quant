/**
 * Manifest-backed completion env for the terminal.
 *
 * The legacy `CommandRegistry` is empty post-migration; tab-completion
 * derives its command + subcommand lists straight from
 * `INSTRUCTION_MANIFEST` (the cross-side source of truth). Per-id
 * positional completers (today: stock-code prompts) are wired by id
 * so the terminal stays consistent with `manifest.ts`.
 */

import { INSTRUCTION_MANIFEST, type CommandManifestEntry } from '@quant/shared';
import type { CompleterEnv, CompletionCandidate, StockIndex } from '@quant/terminal';

const ALL_ENTRIES = Object.values(INSTRUCTION_MANIFEST) as readonly CommandManifestEntry[];

/** Ids whose first positional is a 6-digit A-share code. */
const STOCK_CODE_IDS: ReadonlySet<string> = new Set([
  'stock.info',
  'stock.kline',
  'analyze',
  'ta',
  'focus',
  'watch.add',
]);

export function buildCompleterEnv(stockIndex: StockIndex): CompleterEnv {
  const heads = new Set<string>();
  const subs = new Map<string, Set<string>>();
  for (const e of ALL_ENTRIES) {
    const dot = e.id.indexOf('.');
    if (dot === -1) {
      heads.add(e.id);
      if (!subs.has(e.id)) subs.set(e.id, new Set());
    } else {
      const head = e.id.slice(0, dot);
      const sub = e.id.slice(dot + 1);
      heads.add(head);
      const bucket = subs.get(head) ?? new Set<string>();
      bucket.add(sub);
      subs.set(head, bucket);
    }
    for (const alias of e.aliases ?? []) heads.add(alias);
  }
  const commands = [...heads].sort();
  const subcommands: Record<string, readonly string[]> = {};
  for (const [head, set] of subs) subcommands[head] = [...set].sort();

  return {
    commands,
    subcommands,
    paramCompleter: (cmd, idx, fragment): readonly CompletionCandidate[] => {
      if (idx !== 0) return [];
      if (!STOCK_CODE_IDS.has(cmd)) return [];
      return stockIndex.complete(fragment).map((m) => ({
        insert: m.code,
        label: m.label,
      }));
    },
  };
}
