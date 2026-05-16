/**
 * Wires every command into a fresh registry. Hosts can either use
 * `createDefaultRegistry()` for the full quant command surface or import
 * individual commands and assemble a custom registry.
 */

import { agentCommand } from './agent.js';
import { analyzeCommand } from './analyze.js';
import { sectorCommand } from './sector.js';
import { taCommand } from './ta.js';
import { screenCommand } from './screen.js';
import { watchCommand } from './watch.js';
import { createRegistry, type CommandRegistry } from '../registry.js';

export {
  agentCommand,
  analyzeCommand,
  sectorCommand,
  taCommand,
  screenCommand,
  watchCommand,
};

export function createDefaultRegistry(): CommandRegistry {
  const r = createRegistry();
  r.register(sectorCommand);
  r.register(analyzeCommand);
  r.register(taCommand);
  r.register(watchCommand);
  r.register(screenCommand);
  r.register(agentCommand);
  // Migrated to `apps/web/lib/instructions/cells/*.cell.ts`:
  //   usr, clear, cache, focus, update, help, ledger.*, stock.*
  return r;
}
