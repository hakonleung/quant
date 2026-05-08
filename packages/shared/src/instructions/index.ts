/**
 * `@quant/shared/instructions` — cross-process contract for the
 * instruction set. See `docs/modules/15-instructions.md`.
 *
 * Intentionally minimal: id naming + line parser + result type. Per-side
 * spec shapes diverge (FE has tab-completion + interactive widgets, BE
 * has zod argsSchema + Nest-injected handlers), so spec types live in
 * each consumer.
 */

export * from './id.js';
export * from './parser.js';
export * from './result.js';
