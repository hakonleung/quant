/**
 * FE `/help` cell — pure-FE manifest enumeration.
 *
 * Handler reads `INSTRUCTION_MANIFEST` directly (no BE call) and
 * builds the listing or single-id detail. Result type stays on
 * `LegacyOutputSchema` ({text, meta?}) because BE's IM-side help
 * handler still returns the legacy envelope; using the same shape
 * keeps the cross-side contract honest.
 */

import {
  INSTRUCTION_MANIFEST,
  InstructionDispatchError,
  type CommandManifestEntry,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';
import { renderTable, textErr, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type HelpResult = ResultOf<'help'>;

export function buildHelpCell(): InstructionCell<FeEnv, 'help'> {
  return {
    async handler(args): Promise<HelpResult> {
      const id = args.id?.trim();
      if (id !== undefined && id.length > 0) return detail(id);
      return list();
    },
    renderer(envelope) {
      if (!envelope.ok) return textErr(envelope.error.message);
      return textOk(envelope.data.text);
    },
  };
}

function list(): HelpResult {
  const entries = [...allEntries()].sort((a, b) => a.id.localeCompare(b.id));
  const rows = entries.map((e) => ({
    NAME: e.id,
    SUMMARY: e.summary,
  }));
  const text = renderTable(rows, [
    { key: 'NAME', header: 'CMD', max: 18 },
    { key: 'SUMMARY', header: 'SUMMARY', max: 80 },
  ]);
  return { text };
}

function detail(id: string): HelpResult {
  const entry = lookup(id);
  if (entry === undefined) {
    throw new InstructionDispatchError('not-found', `unknown command: ${id}`);
  }
  const aliases = (entry.aliases ?? []).join(', ') || '(none)';
  const subs = subcommandsOf(entry.id).join(' / ') || '(none)';
  const lines = [
    `# ${entry.id}`,
    `aliases:     ${aliases}`,
    `subcommands: ${subs}`,
    `group:       ${entry.group}`,
    ``,
    entry.summary,
  ];
  if (entry.summaryCn !== undefined && entry.summaryCn.length > 0) {
    lines.push(entry.summaryCn);
  }
  return { text: lines.join('\n') };
}

function allEntries(): readonly CommandManifestEntry[] {
  return Object.values(INSTRUCTION_MANIFEST) as readonly CommandManifestEntry[];
}

function lookup(token: string): CommandManifestEntry | undefined {
  for (const e of allEntries()) {
    if (e.id === token) return e;
    if ((e.aliases ?? []).includes(token)) return e;
  }
  return undefined;
}

function subcommandsOf(head: string): readonly string[] {
  const prefix = `${head}.`;
  return allEntries()
    .filter((e) => e.id.startsWith(prefix))
    .map((e) => e.id.slice(prefix.length))
    .sort();
}
