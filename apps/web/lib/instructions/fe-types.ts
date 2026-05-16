/**
 * FE-side execution environment for `InstructionCenter`.
 *
 * Mirrors the BE's `BeEnv` shape: `ctx` is the handler dependency
 * bag, `host` the renderer's, `output` the renderer return type.
 *
 * On FE:
 *   - `ctx` carries the InstructionInvoker (typed `/api/instructions/:id`
 *     client) plus the stock-completion index, abort signal, UI
 *     stores, and the optional engine dispatcher for streaming cells
 *     (only `/agent` uses that).
 *   - `host` is the terminal-render bag. Empty today; future
 *     widget-prompting helpers (prompt(), pickStock(), …) land here.
 *   - `output` is `CommandRunOutput` — the legacy terminal-engine-
 *     readable union (text / interactive widget / engine event).
 *     The FE shell hands this straight back to the reducer so the
 *     migration is incremental: cells produce the same shape legacy
 *     commands did.
 */

import type {
  AllInstructionIds,
  ArgsOf,
  InstructionEnvelope,
  ResultOf,
} from '@quant/shared';
import type {
  CommandCtx,
  CommandRunOutput,
  StockIndex,
} from '@quant/terminal';

import type { InvokeOptions } from './client.js';

/**
 * Typed `/api/instructions/:id` proxy — what FE cells call to reach
 * the BE cell's `handler` output. Returns `InstructionEnvelope<ResultOf<I>>`
 * so the cell's renderer branches on `ok` uniformly.
 */
export interface InstructionInvoker {
  invoke<I extends AllInstructionIds>(
    id: I,
    args: ArgsOf<I>,
    options?: InvokeOptions,
  ): Promise<InstructionEnvelope<ResultOf<I>>>;
}

export interface FeCtx extends CommandCtx {
  /** Typed BE dispatcher — every cell calls this for data. */
  readonly api: InstructionInvoker;
}

/**
 * Renderer dependency bag. Today exposes the stock completion index
 * so cells like `focus` can render an interactive picker without
 * reaching into `ctx` (renderers only receive `host` per the cell
 * model). Grows as more widget primitives surface.
 */
export interface TermHost {
  readonly stockIndex: StockIndex;
}

export type TermOutput = CommandRunOutput;

export interface FeEnv {
  ctx: FeCtx;
  host: TermHost;
  output: TermOutput;
}
