/**
 * DI tokens for the LLM module. Kept in their own file so other modules
 * can `@Inject(LLM_CONFIG)` etc. without pulling the whole module
 * surface (which would create a service ↔ module cycle).
 */

export const LLM_CONFIG = Symbol('LLM_CONFIG');
export const LLM_LEDGER_DATA_DIR = Symbol('LLM_LEDGER_DATA_DIR');
export const USER_LLM_LEDGER_USER_RECORD_STORE = Symbol('USER_LLM_LEDGER_USER_RECORD_STORE');
