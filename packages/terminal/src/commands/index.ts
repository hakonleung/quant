/**
 * Wires every command into a fresh registry. Hosts can either use
 * `createDefaultRegistry()` for the full quant command surface or import
 * individual commands and assemble a custom registry.
 */

import { agentCommand } from './agent.js';
import { analyzeCommand } from './analyze.js';
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
  r.register(sectorCommand);
  r.register(analyzeCommand);
  r.register(taCommand);
  r.register(watchCommand);
  r.register(ledgerCommand);
  r.register(screenCommand);
  r.register(updateCommand);
  // The following are served by the FE InstructionCenter cells in
  // `apps/web/lib/instructions/cells/*.cell.ts`. The terminal shell
  // checks `feCenterCanDispatch(line)` first; misses fall through here.
  //   - usr   — typed BE proxy
  //   - clear — engine-event cell
  //   - cache — FE runner-cache inspect / clear
  //   - focus — FE focus state + interactive picker
  r.register(agentCommand);
  r.register(helpCommand(r));
  return r;
}
