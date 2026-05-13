/**
 * DI tokens for the LLM module. Kept in their own file so other modules
 * can `@Inject(LLM_LEDGER_DATA_DIR)` etc. without pulling the whole
 * module surface.
 */

export const LLM_LEDGER_DATA_DIR = Symbol('LLM_LEDGER_DATA_DIR');
export const USER_LLM_LEDGER_USER_RECORD_STORE = Symbol('USER_LLM_LEDGER_USER_RECORD_STORE');
