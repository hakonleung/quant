/**
 * Async dispatcher that translates a submitted command line into the next
 * `Event` (or chain of events) for the engine.
 *
 * The reducer never runs side effects directly — when it emits a
 * `runCommand` effect, the host calls `runCommand(line, ctx, registry)`.
 * The result is either a text output or an interactive widget, which the
 * host then dispatches as a new `Event`.
 *
 * Pure async function — no React, no DOM (CLAUDE.md §2.5.1).
 */

import { ZodError } from 'zod';
import { QuantError } from '@quant/shared';

import { ANSI, paint } from '../render/ansi.js';
import { CommandError, type CommandCtx, type CommandRegistry, type CommandRunOutput } from '../registry.js';
import { ArgvParseError, parseLine } from './parse-argv.js';
import type { Event } from './state.js';

export async function runCommand(
  line: string,
  ctx: CommandCtx,
  registry: CommandRegistry,
): Promise<Event> {
  try {
    const argv = parseLine(line);
    const head = argv.positional[0];
    if (head === undefined) {
      return text('', 'info');
    }
    const spec = registry.resolve(head);
    if (spec === undefined) {
      return text(paint(`unknown command: ${head}`, ANSI.red), 'err');
    }
    // Drop the command name from positional so commands see args directly.
    const subArgv = { ...argv, positional: argv.positional.slice(1) };
    const out: CommandRunOutput = await spec.run(subArgv, ctx);
    if (out.kind === 'interactive') {
      return { kind: 'startInteractive', widget: out.widget };
    }
    return text(out.tail.body, out.status);
  } catch (err) {
    if (err instanceof ArgvParseError) {
      return text(paint(`parse error: ${err.message}`, ANSI.red), 'err');
    }
    if (err instanceof CommandError) {
      return text(paint(err.message, ANSI.red), 'err');
    }
    if (err instanceof ZodError) {
      const lines = err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
      return text(paint(`validation error:\n  ${lines.join('\n  ')}`, ANSI.red), 'err');
    }
    if (err instanceof QuantError) {
      return text(paint(`${err.code}: ${err.message}`, ANSI.red), 'err');
    }
    if (err instanceof Error) {
      return text(paint(`error: ${err.message}`, ANSI.red), 'err');
    }
    return text(paint('unknown error', ANSI.red), 'err');
  }
}

function text(
  body: string,
  status: 'ok' | 'err' | 'cached' | 'info',
): Event {
  return { kind: 'result', entry: { body, status } };
}
