/**
 * Wires every command into a fresh registry. Hosts can either use
 * `createDefaultRegistry()` for the full quant command surface or import
 * individual commands and assemble a custom registry.
 */

import { agentCommand } from './agent.js';
import { sectorCommand } from './sector.js';
import { watchCommand } from './watch.js';
import { createRegistry, type CommandRegistry } from '../registry.js';

export { agentCommand, sectorCommand, watchCommand };

export function createDefaultRegistry(): CommandRegistry {
  const r = createRegistry();
  r.register(sectorCommand);
  r.register(watchCommand);
  r.register(agentCommand);
  // Migrated to `apps/web/lib/instructions/cells/*.cell.ts`:
  //   usr, clear, cache, focus, update, help, ledger.*, stock.*,
  //   screen, analyze.*, ta.*
  return r;
}
