/**
 * `@quant/terminal` — keyboard-driven command terminal core.
 *
 * Layered architecture (CLAUDE.md §2.5.1 — pure / no IO):
 *   render/      ANSI / table / sparkline rendering
 *   engine/      pure reducer + dispatcher + key + parse-argv + types
 *   widgets/     interactive primitives (selectable list, form, confirm, ...)
 *   completion/  Tab completion + stock prefix index
 *   actions/     data-action registry + mock backend
 *   commands/    quant-specific command implementations
 *   registry.ts  command registry contract
 *
 * Hosts (e.g. `apps/web` Next.js / future Electron / VS Code) bridge
 * xterm.js or any other emulator to this engine via the public types.
 */

export * from './render/index.js';
export * from './engine/index.js';
export * from './widgets/index.js';
export * from './completion/index.js';
export * from './actions/index.js';
export * from './commands/index.js';
export * from './registry.js';
