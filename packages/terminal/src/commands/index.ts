/**
 * Wires every command into a fresh registry. Hosts can either use
 * `createDefaultRegistry()` for the full quant command surface or import
 * individual commands and assemble a custom registry.
 */

import { assertHandlerCoverage } from '@quant/shared';

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
import { usrCommand } from './usr.js';
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
  usrCommand,
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
  r.register(usrCommand);
  r.register(agentCommand);
  r.register(helpCommand(r));
  // Fail-loud if the FE registry drifts from the shared manifest —
  // the user's "explicit declaration of unsupported commands" rule
  // applies to FE the same way it does to BE.
  assertHandlerCoverage({
    side: 'fe',
    registeredIds: r.list().map((s) => s.name),
  });
  return r;
}
