/**
 * FE-side singleton `InstructionCenter`.
 *
 * Mirrors the BE `BeInstructionCenter` shape: one cell per migrated
 * id, the rest in `Excluded`. The FE shell (`useTerminal`) checks
 * `feCenter.has(id)` before dispatching; misses fall through to the
 * legacy `CommandRegistry`, so the migration is incremental.
 *
 * Grow `MigratedIds` one id at a time. The mapped-type config check
 * fails the build if you add an id here without a matching cell file
 * (and vice versa).
 */

import {
  InstructionCenter,
  type AllInstructionIds,
  type InstructionConfig,
} from '@quant/shared';

import { invokeInstruction, type InvokeOptions } from './client.js';
import type { FeEnv, InstructionInvoker } from './fe-types.js';
import { buildCacheCell } from './cells/cache.cell.js';
import { buildClearCell } from './cells/clear.cell.js';
import { buildFocusCell } from './cells/focus.cell.js';
import { buildHelpCell } from './cells/help.cell.js';
import { buildLedgerCell } from './cells/ledger.cell.js';
import { buildLedgerAddCell } from './cells/ledger-add.cell.js';
import { buildLedgerAnalyzeCell } from './cells/ledger-analyze.cell.js';
import { buildLedgerRemoveCell } from './cells/ledger-remove.cell.js';
import { buildStockCell } from './cells/stock.cell.js';
import { buildStockInfoCell } from './cells/stock-info.cell.js';
import { buildStockKlineCell } from './cells/stock-kline.cell.js';
import { buildUpdateCell } from './cells/update.cell.js';
import { buildUsrCell } from './cells/usr.cell.js';

/**
 * Migrated FE instruction ids — extend as cells move from the legacy
 * `packages/terminal/src/commands/` directory to here. BE-only ids
 * (`sector.publish` / `analyze.sector` / agent.confirm / channel.send
 *  / web.search / etc.) stay excluded — they're never invoked from FE.
 */
export type FeMigratedIds =
  | 'usr'
  | 'clear'
  | 'cache'
  | 'focus'
  | 'update'
  | 'help'
  | 'ledger'
  | 'ledger.add'
  | 'ledger.remove'
  | 'ledger.analyze'
  | 'stock'
  | 'stock.info'
  | 'stock.kline';

type Excluded = Exclude<AllInstructionIds, FeMigratedIds>;
type Configured = Exclude<AllInstructionIds, Excluded>;

/** Process-singleton invoker — every cell uses the same client. */
const defaultInvoker: InstructionInvoker = {
  invoke: <I extends AllInstructionIds>(
    id: I,
    args: import('@quant/shared').ArgsOf<I>,
    options?: InvokeOptions,
  ) => invokeInstruction(id, args, options),
};

export function buildFeCenter(): InstructionCenter<FeEnv, Excluded> {
  const cfg: InstructionConfig<FeEnv, Excluded> = {
    usr: buildUsrCell(),
    clear: buildClearCell(),
    cache: buildCacheCell(),
    focus: buildFocusCell(),
    update: buildUpdateCell(),
    help: buildHelpCell(),
    ledger: buildLedgerCell(),
    'ledger.add': buildLedgerAddCell(),
    'ledger.remove': buildLedgerRemoveCell(),
    'ledger.analyze': buildLedgerAnalyzeCell(),
    stock: buildStockCell(),
    'stock.info': buildStockInfoCell(),
    'stock.kline': buildStockKlineCell(),
  };
  return new InstructionCenter<FeEnv, Excluded>(cfg);
}

/** Process-wide singleton. Hooks (`useTerminal`) consume this directly. */
export const feCenter = buildFeCenter();

export type FeConfiguredId = Configured;

export { defaultInvoker };
