import type { CommandSpec } from '../registry.js';
import { textOk } from '../widgets/helpers.js';

/**
 * `clear` is mainly handled by the engine via Ctrl-L (which clears the
 * scrollback). Submitting `clear` produces an explicit "ok cleared" tail
 * and the host watches for the special body to flush its own buffer.
 */
export const clearCommand: CommandSpec = {
  name: 'clear',
  aliases: ['cls'],
  summary: 'Clear the terminal scrollback.',
  async run() {
    return textOk('\x1b[2J\x1b[H');
  },
};
