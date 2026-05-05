import type { CommandSpec } from '../registry.js';
import { textErr } from '../widgets/helpers.js';

/**
 * `clear`           — wipe scrollback (every interaction).
 * `clear last [N]`  — drop the last N interactions (default 1). One
 *                     "interaction" = a prompt line plus everything between
 *                     it and the next prompt (output / frozen widget).
 *
 * Ctrl-L is a separate, engine-level full clear handled by the reducer.
 */
export const clearCommand: CommandSpec = {
  name: 'clear',
  aliases: ['cls'],
  summary: 'Clear the terminal scrollback. Use `clear last [N]` to hide recent N interactions.',
  subcommands: ['last'],
  async run(argv) {
    const sub = argv.positional[0];
    if (sub === undefined) {
      return { kind: 'engine', events: [{ kind: 'clearAll' }] };
    }
    if (sub === 'last') {
      const raw = argv.positional[1];
      const n = raw === undefined ? 1 : Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return textErr('usage: clear last [N]   (N must be a positive integer)');
      }
      // Drop the `clear last N` prompt itself first (count + 1) so the
      // command line that triggered the clear also vanishes.
      return { kind: 'engine', events: [{ kind: 'clearLast', count: n + 1 }] };
    }
    return textErr(`clear: unknown subcommand "${sub}"`);
  },
};
