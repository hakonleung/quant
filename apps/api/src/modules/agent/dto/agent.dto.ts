/**
 * Re-exports for `/agent` and `/agent.confirm` arg schemas — the real
 * definitions live in `packages/shared/src/instructions/schemas.ts` so
 * both the BE handlers and the manifest reference the same binding.
 * Kept as a thin module to avoid churning the existing handler imports.
 */

export { AgentArgsSchema, AgentConfirmArgsSchema } from '@quant/shared';
export type { AgentArgs, AgentConfirmArgs } from '@quant/shared';
