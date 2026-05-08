/**
 * `ledger` command — personal P/L journal.
 *
 * Subcommands:
 *   - `ledger ls [--limit N]`            — newest-first table
 *   - `ledger add <date> <pnl> [closing]`— upsert; first entry needs closing
 *   - `ledger rm <date>`                 — delete one entry (confirm)
 *   - `ledger analyze [--force]`         — 30d AI review (paid; cached free)
 *
 * Cache invalidation: every write goes through `ctx.stores.revalidate('ledger')`
 * so the React side picks up changes without a manual refetch.
 */

import { LedgerEntrySchema, type EnrichedLedgerEntry } from '@quant/shared';

import {
  analyzeLedgerAction,
  ledgerListAction,
  ledgerRemoveAction,
  ledgerUpsertAction,
} from '../actions/registry.js';
import { ANSI, paint } from '../render/ansi.js';
import type { CommandSpec } from '../registry.js';
import { confirmPrompt } from '../widgets/confirm-prompt.js';
import {
  canceledResolution,
  interactive,
  textCached,
  textErr,
  textOk,
} from '../widgets/helpers.js';

export const ledgerCommand: CommandSpec = {
  name: 'ledger',
  summary: 'Personal P/L ledger. Subcommands: ls, add, rm, analyze.',
  subcommands: ['ls', 'add', 'rm', 'analyze'],
  async run(argv, ctx) {
    const sub = argv.positional[0];
    if (sub === undefined) return textErr('ledger: missing subcommand (ls/add/rm/analyze)');
    if (sub === 'ls') return runList(argv, ctx);
    if (sub === 'add') return runAdd(argv, ctx);
    if (sub === 'rm') return runRemove(argv, ctx);
    if (sub === 'analyze') return runAnalyze(argv, ctx);
    return textErr(`ledger: unknown subcommand ${sub}`);
  },
};

async function runList(
  argv: Parameters<CommandSpec['run']>[0],
  ctx: Parameters<CommandSpec['run']>[1],
): ReturnType<CommandSpec['run']> {
  const r = await ctx.actions.run(ledgerListAction, {}, { signal: ctx.signal });
  const limitRaw = argv.flags['limit'];
  const limit =
    typeof limitRaw === 'string' ? Math.max(1, Number.parseInt(limitRaw, 10) || 20) : 20;
  if (r.data.length === 0) {
    return textOk('ledger is empty — `ledger add <date> <pnl> <closing>`');
  }
  const recent = [...r.data].reverse().slice(0, limit);
  const body = formatTable(recent);
  return r.cached ? textCached(body) : textOk(body);
}

async function runAdd(
  argv: Parameters<CommandSpec['run']>[0],
  ctx: Parameters<CommandSpec['run']>[1],
): ReturnType<CommandSpec['run']> {
  const date = argv.positional[1];
  const pnl = argv.positional[2];
  const closing = argv.positional[3];
  if (date === undefined || pnl === undefined) {
    return textErr('usage: ledger add <YYYY-MM-DD> <pnl> [<closing>]');
  }
  const entry = LedgerEntrySchema.safeParse({
    date,
    pnlAmount: pnl,
    ...(closing !== undefined ? { closingPosition: closing } : {}),
  });
  if (!entry.success) {
    return textErr(`ledger add: ${entry.error.issues[0]?.message ?? 'invalid input'}`);
  }
  await ctx.actions.run(ledgerUpsertAction, { entry: entry.data }, { signal: ctx.signal });
  ctx.stores.revalidate?.('ledger');
  return textOk(`added ${date}  pnl=${pnl}${closing !== undefined ? `  closing=${closing}` : ''}`);
}

async function runRemove(
  argv: Parameters<CommandSpec['run']>[0],
  ctx: Parameters<CommandSpec['run']>[1],
): ReturnType<CommandSpec['run']> {
  const date = argv.positional[1];
  if (date === undefined) return textErr('usage: ledger rm <YYYY-MM-DD>');
  const widget = confirmPrompt({
    title: `delete ledger entry ${date}?`,
    danger: true,
    onYes: () => ({ kind: 'command', line: `ledger rm-confirmed ${date}` }),
    onNo: () => canceledResolution,
  });
  // Special-cased confirmation flow: the second pass dispatches via the
  // hidden `rm-confirmed` subpath. Two-stage to keep the confirm widget
  // generic with the rest of the term.
  if (argv.positional[0] === 'rm-confirmed') {
    await ctx.actions.run(ledgerRemoveAction, { date }, { signal: ctx.signal });
    ctx.stores.revalidate?.('ledger');
    return textOk(`removed ${date}`);
  }
  return interactive(widget);
}

async function runAnalyze(
  argv: Parameters<CommandSpec['run']>[0],
  ctx: Parameters<CommandSpec['run']>[1],
): ReturnType<CommandSpec['run']> {
  const force = argv.flags['force'] === true || argv.flags['force'] === 'true';
  const r = await ctx.actions.run(analyzeLedgerAction, force ? { force } : {}, {
    signal: ctx.signal,
  });
  const body = formatAnalysis(r.data);
  return r.cached ? textCached(body) : textOk(body);
}

// ---------- formatting ----------

function formatTable(entries: readonly EnrichedLedgerEntry[]): string {
  const lines: string[] = [];
  lines.push(paint('DATE        PNL          PCT      CLOSING       CASHFLOW', ANSI.bold));
  for (const e of entries) {
    const pnlNum = Number(e.pnlAmount);
    const pnlColor = pnlNum > 0 ? ANSI.green : pnlNum < 0 ? ANSI.red : ANSI.gray;
    const closingMark = e.closingProvided ? ' ' : '~';
    const cashFlow = e.cashFlow === '0' ? '       —' : pad(e.cashFlow, 8);
    const pct = Number(e.derivedDailyPct).toFixed(2);
    lines.push(
      `${e.date}  ${paint(pad(e.pnlAmount, 11), pnlColor)}  ${pad(pct, 6)}%  ${pad(e.derivedClosingPosition, 10)}${closingMark} ${cashFlow}`,
    );
  }
  return lines.join('\n');
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value;
  return ' '.repeat(width - value.length) + value;
}

function formatAnalysis(a: {
  summary: string;
  operationStyle: string;
  marketView: string;
  recommendations: readonly string[];
  windowStart: string;
  windowEnd: string;
  entryCount: number;
  provider: string;
}): string {
  const lines: string[] = [];
  lines.push(
    paint(
      `ledger analysis  ${a.windowStart} → ${a.windowEnd}  (${String(a.entryCount)} entries, ${a.provider || 'unknown'})`,
      ANSI.bold,
      ANSI.cyan,
    ),
  );
  lines.push('');
  lines.push(paint('summary:', ANSI.bold));
  lines.push(`  ${a.summary}`);
  lines.push('');
  lines.push(paint('operation style:', ANSI.bold));
  lines.push(`  ${a.operationStyle}`);
  lines.push('');
  lines.push(paint('market view:', ANSI.bold));
  lines.push(`  ${a.marketView}`);
  if (a.recommendations.length > 0) {
    lines.push('');
    lines.push(paint('recommendations:', ANSI.bold));
    for (const [i, r] of a.recommendations.entries()) {
      lines.push(`  ${String(i + 1)}. ${r}`);
    }
  }
  return lines.join('\n');
}
