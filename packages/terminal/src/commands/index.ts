/**
 * Wires every command into a fresh registry. Hosts can either use
 * `createDefaultRegistry()` for the full quant command surface or import
 * individual commands and assemble a custom registry.
 */

import { agentCommand } from './agent.js';
import { analyzeCommand } from './analyze.js';
import { cacheCommand } from './cache.js';
import { clearCommand } from './clear.js';
import { focusCommand } from './focus.js';
import { helpCommand } from './help.js';
import { ledgerCommand } from './ledger.js';
import { sectorCommand } from './sector.js';
import { stockCommand } from './stock.js';
import { taCommand } from './ta.js';
import { screenCommand } from './screen.js';
import { updateCommand } from './update.js';
import { watchCommand } from './watch.js';
import { createRegistry, type CommandRegistry } from '../registry.js';

export {
  agentCommand,
  analyzeCommand,
  cacheCommand,
  clearCommand,
  focusCommand,
  helpCommand,
  ledgerCommand,
  sectorCommand,
  stockCommand,
  taCommand,
  screenCommand,
  updateCommand,
  watchCommand,
};

export function createDefaultRegistry(): CommandRegistry {
  const r = createRegistry();
  r.register(stockCommand);
  r.register(focusCommand);
  r.register(sectorCommand);
  r.register(analyzeCommand);
  r.register(taCommand);
  r.register(watchCommand);
  r.register(ledgerCommand);
  r.register(screenCommand);
  r.register(updateCommand);
  r.register(cacheCommand);
  r.register(clearCommand);
  // `usr` migrated to FE InstructionCenter cell — apps/web handles it
  // via feCenter intercept before falling through to this registry.
  r.register(agentCommand);
  r.register(helpCommand(r));
  return r;
}
