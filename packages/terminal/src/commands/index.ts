/**
 * Wires every command into a fresh registry. Hosts can either use
 * `createDefaultRegistry()` for the full quant command surface or import
 * individual commands and assemble a custom registry.
 */

import { createRegistry, type CommandRegistry } from '../registry.js';

/**
 * Empty by design — every instruction now lives on `feCenter`
 * (apps/web/lib/instructions/cells/*.cell.ts). The terminal shell
 * checks feCenter first and nothing falls through here. The factory
 * stays as a no-op anchor for any future host-specific commands
 * that don't belong in the cross-side manifest.
 */
export function createDefaultRegistry(): CommandRegistry {
  return createRegistry();
}
