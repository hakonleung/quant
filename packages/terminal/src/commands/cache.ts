import { renderTable } from '../render/table.js';
import type { CommandSpec } from '../registry.js';
import { textErr, textOk } from '../widgets/helpers.js';

/**
 * `:cache stats` / `:cache clear` — operates on the active runner cache.
 * Implemented as the `cache` command (the leading ":" sigil is allowed
 * via alias).
 */
export const cacheCommand: CommandSpec = {
  name: 'cache',
  aliases: [':cache'],
  summary: 'Inspect or clear the terminal data cache.',
  subcommands: ['stats', 'clear'],
  async run(argv, ctx) {
    const sub = argv.positional[0];
    if (sub === undefined || sub === 'stats') {
      const s = ctx.actions.stats();
      return textOk(
        renderTable(
          [{ K: 'entries', V: s.entries }, { K: 'hits', V: s.hits }, { K: 'misses', V: s.misses }],
          [
            { key: 'K', header: 'KEY', max: 12 },
            { key: 'V', header: 'VAL', align: 'right' },
          ],
        ),
      );
    }
    if (sub === 'clear') {
      const prefix = argv.positional.slice(1);
      ctx.actions.invalidate(prefix.length === 0 ? [] : prefix);
      return textOk(`cleared (prefix=${prefix.length === 0 ? '*' : prefix.join('|')})`);
    }
    return textErr(`unknown subcommand: ${sub}`);
  },
};
