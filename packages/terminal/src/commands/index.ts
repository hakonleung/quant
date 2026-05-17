/**
 * Wires every command into a fresh registry. Hosts can either use
 * `createDefaultRegistry()` for the full quant command surface or import
 * individual commands and assemble a custom registry.
 */

import { agentCommand } from './agent.js';
import { createRegistry, type CommandRegistry } from '../registry.js';

export { agentCommand };

export function createDefaultRegistry(): CommandRegistry {
  const r = createRegistry();
  r.register(agentCommand);
  // All other instructions live on `feCenter`
  // (apps/web/lib/instructions/cells/*.cell.ts). The terminal shell
  // checks feCenter first; only `/agent` falls through here because
  // its streaming subscription doesn't fit the request/response cell
  // shape yet.
  return r;
}
