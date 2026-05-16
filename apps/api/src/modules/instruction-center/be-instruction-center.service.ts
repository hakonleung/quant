/**
 * BE-side singleton `InstructionCenter` instance.
 *
 * Owns the typed configuration map for every instruction migrated to
 * the new cell model. Phase 2 grows the `Migrated` union one cell at
 * a time; everything not in `Migrated` stays excluded here and falls
 * through to the legacy `InstructionRegistry`/handler registration in
 * `InstructionExecutor`.
 *
 * The intercept contract used by `InstructionExecutor`:
 *   - `has(id)` — true when this center owns the instruction (legacy
 *     executor must defer).
 *   - `executeMigrated(id, args, ctx)` — bypasses tokenize/coerce; the
 *     executor has already validated args via the manifest schema.
 *     Returns the legacy `InstructionResult` envelope so the IM
 *     listener / async bus don't need to know about cells.
 *
 * As more cells migrate, expand `Migrated` and add to the config map.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  InstructionCenter,
  type AllInstructionIds,
  type InstructionConfig,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import { CLOCK, type Clock } from '../../common/clock.js';
import { AuthConfig } from '../auth/config/auth.config.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { LlmService } from '../llm/llm.service.js';
import { UserLlmLedgerStore } from '../llm/ledger/user-llm-ledger.store.js';
import { CronOrchestrator } from '../orchestration/cron.orchestrator.js';
import { ScreenService } from '../screen/screen.service.js';
import { SectorsService } from '../sectors/sectors.service.js';
import { NewsSentimentService } from '../sentiment/news-sentiment.service.js';
import { StockListService } from '../stock-list/stock-list.service.js';
import { StockMetaService } from '../stock-meta/stock-meta.service.js';
import { TaService } from '../ta/ta.service.js';
import { WatchTaskStore } from '../watch/watch-task.store.js';
import { WatchService } from '../watch/watch.service.js';

import type { BeEnv, BeCtx, ImHost, ImOutput } from './be-types.js';
import { buildAnalyzeCell } from './cells/analyze.cell.js';
import { buildLedgerCell } from './cells/ledger.cell.js';
import { buildLedgerAnalyzeCell } from './cells/ledger-analyze.cell.js';
import { buildSectorCell } from './cells/sector.cell.js';
import {
  buildSectorPublishCell,
  buildSectorUnpublishCell,
} from './cells/sector-publish.cell.js';
import { buildScreenCell } from './cells/screen.cell.js';
import { buildSectorRmCell } from './cells/sector-rm.cell.js';
import { buildSectorShowCell } from './cells/sector-show.cell.js';
import { buildStockCell } from './cells/stock.cell.js';
import { buildTaCell } from './cells/ta.cell.js';
import { buildTaSectorCell } from './cells/ta-sector.cell.js';
import { buildUpdateCell } from './cells/update.cell.js';
import { buildUsrCell } from './cells/usr.cell.js';
import { buildWatchCell } from './cells/watch.cell.js';
import { buildWatchAddCell } from './cells/watch-add.cell.js';
import { buildWatchGroupCell } from './cells/watch-group.cell.js';
import { buildWatchRemoveCell } from './cells/watch-remove.cell.js';
import { buildWebSearchCell } from './cells/web-search.cell.js';

/**
 * Migrated instruction ids — grow this union one entry at a time as
 * each handler moves from the legacy `InstructionRegistry` to the
 * cell model. The mapped config type enforces that every id listed
 * here has a corresponding cell at compile time.
 */
export type MigratedIds =
  | 'usr'
  | 'sector'
  | 'sector.publish'
  | 'sector.unpublish'
  | 'sector.rm'
  | 'ledger'
  | 'stock'
  | 'watch'
  | 'watch.add'
  | 'watch.remove'
  | 'watch.group'
  | 'analyze'
  | 'ta'
  | 'ta.sector'
  | 'screen'
  | 'ledger.analyze'
  | 'web.search'
  | 'update'
  | 'sector.show';

type Excluded = Exclude<AllInstructionIds, MigratedIds>;
type Configured = Exclude<AllInstructionIds, Excluded>;

@Injectable()
export class BeInstructionCenter {
  private readonly center: InstructionCenter<BeEnv, Excluded>;
  /** Empty host today — explicit object so renderers see a stable shape. */
  private readonly host: ImHost = {};

  constructor(
    @Inject(AuthConfig) authCfg: AuthConfig,
    @Inject(UserLlmLedgerStore) ledger: UserLlmLedgerStore,
    @Inject(CLOCK) clock: Clock,
    @Inject(SectorsService) sectors: SectorsService,
    @Inject(LedgerService) ledgerService: LedgerService,
    @Inject(StockMetaService) stockMeta: StockMetaService,
    @Inject(WatchService) watch: WatchService,
    @Inject(StockListService) stockList: StockListService,
    @Inject(NewsSentimentService) sentiment: NewsSentimentService,
    @Inject(WatchTaskStore) watchTaskStore: WatchTaskStore,
    @Inject(TaService) ta: TaService,
    @Inject(ScreenService) screen: ScreenService,
    @Inject(LlmService) llm: LlmService,
    @Inject(CronOrchestrator) cron: CronOrchestrator,
  ) {
    const cfg: InstructionConfig<BeEnv, Excluded> = {
      usr: buildUsrCell({ authCfg, ledger, clock }),
      sector: buildSectorCell({ sectors }),
      'sector.publish': buildSectorPublishCell({ sectors }),
      'sector.unpublish': buildSectorUnpublishCell({ sectors }),
      'sector.rm': buildSectorRmCell({ sectors }),
      ledger: buildLedgerCell({ ledger: ledgerService }),
      stock: buildStockCell({ stockMeta }),
      watch: buildWatchCell({ watch, stockList }),
      'watch.add': buildWatchAddCell({ watch }),
      'watch.remove': buildWatchRemoveCell({ taskStore: watchTaskStore }),
      'watch.group': buildWatchGroupCell({ watch }),
      analyze: buildAnalyzeCell({ sentiment }),
      ta: buildTaCell({ ta }),
      'ta.sector': buildTaSectorCell({ ta, sectors }),
      screen: buildScreenCell({ screen, stockList }),
      'ledger.analyze': buildLedgerAnalyzeCell({ ledger: ledgerService }),
      'web.search': buildWebSearchCell({ llm }),
      update: buildUpdateCell({ cron }),
      'sector.show': buildSectorShowCell({ sectors, stockList }),
    };
    this.center = new InstructionCenter<BeEnv, Excluded>(cfg);
  }

  has(id: string): boolean {
    return this.center.has(id);
  }

  ids(): readonly Configured[] {
    return this.center.ids();
  }

  /**
   * Executor-facing entry: args have already been validated upstream.
   * Wraps both success and error into the legacy `InstructionResult`
   * envelope via the cell's renderer.
   */
  async executeMigrated(id: Configured, args: unknown, ctx: BeCtx): Promise<ImOutput> {
    return this.executeImpl(id, args, ctx);
  }

  /** Typed-by-id surface for programmatic callers (tests, agent bridge). */
  invoke<I extends Configured>(id: I, args: never, ctx: BeCtx): Promise<ResultOf<I>> {
    return this.center.invoke(id, args, ctx);
  }

  render<I extends Configured>(
    id: I,
    envelope: InstructionEnvelope<ResultOf<I>>,
    host: ImHost = this.host,
  ): ImOutput {
    return this.center.render(id, envelope, host);
  }

  /**
   * IM paid-confirm bypass probe for a migrated id. Returns `false`
   * when the id has no cell `peek` hook — meaning "always show the
   * confirm card". Wraps `InstructionCenter.peek` so the executor's
   * synthesised handler can forward the IM listener's
   * `peekImConfirmBypass` call without reaching into the typed center.
   */
  async peekImConfirmBypass(
    id: Configured,
    rawArgs: Record<string, unknown>,
    ctx: BeCtx,
  ): Promise<boolean> {
    return this.center.peek(id, rawArgs, ctx);
  }

  private async executeImpl(id: Configured, args: unknown, ctx: BeCtx): Promise<ImOutput> {
    try {
      const data = await this.center.invoke(id, args as never, ctx);
      return this.center.render(
        id,
        { ok: true, data } as InstructionEnvelope<ResultOf<Configured>>,
        this.host,
      );
    } catch (err) {
      return this.center.render(
        id,
        {
          ok: false,
          error: { code: 'handler', message: err instanceof Error ? err.message : String(err) },
        },
        this.host,
      );
    }
  }
}
