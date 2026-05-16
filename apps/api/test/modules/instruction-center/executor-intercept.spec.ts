/**
 * Tests that `InstructionExecutor` routes migrated ids through
 * `BeInstructionCenter` instead of the legacy registry.
 *
 * Build a stand-alone executor wired with: empty registry + a real
 * `BeInstructionCenter` containing the `usr` cell. Verify:
 *   - dispatch('usr', ...) returns the cell-rendered InstructionResult
 *   - executeLine('usr') tokenises → routes through center
 *   - executeLine('我的') resolves the IM alias from the manifest
 *   - registry-only ids fall back to the registry
 *   - unknown ids return errResult('not-found')
 */

import { FrozenClock } from '../../../src/common/clock.js';
import type { AuthConfig } from '../../../src/modules/auth/config/auth.config.js';
import {
  InstructionAsyncBus,
  type InstructionAsyncJob,
} from '../../../src/modules/instruction/async/instruction-async.bus.js';
import type { AgentHistoryStore } from '../../../src/modules/agent/agent-history.store.js';
import type { AgentPendingStore } from '../../../src/modules/agent/agent-pending.store.js';
import type { AgentService } from '../../../src/modules/agent/agent.service.js';
import { BeInstructionCenter } from '../../../src/modules/instruction-center/be-instruction-center.service.js';
import { InstructionExecutor } from '../../../src/modules/instruction/instruction.executor.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { LedgerService } from '../../../src/modules/ledger/ledger.service.js';
import type {
  UserLlmLedgerStore,
  UserLlmLedgerSummary,
} from '../../../src/modules/llm/ledger/user-llm-ledger.store.js';
import type { LlmService } from '../../../src/modules/llm/llm.service.js';
import type { CronOrchestrator } from '../../../src/modules/orchestration/cron.orchestrator.js';
import type { ScreenService } from '../../../src/modules/screen/screen.service.js';
import type { SectorsService } from '../../../src/modules/sectors/sectors.service.js';
import type { NewsSentimentService } from '../../../src/modules/sentiment/news-sentiment.service.js';
import type { StockListService } from '../../../src/modules/stock-list/stock-list.service.js';
import type { StockMetaService } from '../../../src/modules/stock-meta/stock-meta.service.js';
import type { TaService } from '../../../src/modules/ta/ta.service.js';
import type { WatchTaskStore } from '../../../src/modules/watch/watch-task.store.js';
import type { WatchService } from '../../../src/modules/watch/watch.service.js';

// eslint-disable-next-line no-restricted-globals
const NOW = new Date('2026-05-16T03:00:00.000Z');

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'admin' };

function emptySummary(): UserLlmLedgerSummary {
  return {
    totalUsage: { input: 0, output: 0, total: 0 },
    callCount: 0,
    byScope: new Map(),
    byModel: new Map(),
  };
}

function build(): {
  exe: InstructionExecutor;
  reg: InstructionRegistry;
  center: BeInstructionCenter;
} {
  const authCfg = { adminUserId: 'admin' } as unknown as AuthConfig;
  const ledger: UserLlmLedgerStore = {
    summarize: () => Promise.resolve(emptySummary()),
  } as unknown as UserLlmLedgerStore;
  const clock = new FrozenClock(NOW);
  const sectors: SectorsService = {
    listVisibleTo: () => [],
  } as unknown as SectorsService;
  const ledgerSvc: LedgerService = {
    enriched: () => Promise.resolve([]),
  } as unknown as LedgerService;
  const stockMeta: StockMetaService = {
    listAll: () => Promise.resolve([]),
    snapshotAll: () => Promise.resolve([]),
  } as unknown as StockMetaService;
  const watch: WatchService = {
    list: () => Promise.resolve([]),
  } as unknown as WatchService;
  const stockList: StockListService = {
    assembleRows: () => Promise.resolve({ rows: [] }),
  } as unknown as StockListService;
  const sentimentSvc: NewsSentimentService = {
    analyzeOne: () => Promise.reject(new Error('not used by this suite')),
    getCachedStock: () => Promise.resolve(null),
  } as unknown as NewsSentimentService;
  const watchTaskStore: WatchTaskStore = {
    deleteByIdx: () => Promise.resolve(undefined),
  } as unknown as WatchTaskStore;
  const ta: TaService = {
    analyzeOne: () => Promise.reject(new Error('not used')),
    getCached: () => Promise.resolve(null),
    analyzeSector: () => Promise.reject(new Error('not used')),
  } as unknown as TaService;
  const screenSvc: ScreenService = {
    runNl: () => Promise.reject(new Error('not used')),
  } as unknown as ScreenService;
  const llm: LlmService = {
    completeWithWebSearch: () => Promise.reject(new Error('not used')),
  } as unknown as LlmService;
  const cron: CronOrchestrator = {
    fireScan: () => ({ started: true, traceId: 'fake-trace' }),
  } as unknown as CronOrchestrator;
  const agentSvc: AgentService = {
    resolveMaxToolCalls: () => 3,
    runFresh: () => Promise.resolve(),
    resume: () => Promise.resolve(),
  } as unknown as AgentService;
  const agentHistory: AgentHistoryStore = {
    recent: () => [],
  } as unknown as AgentHistoryStore;
  const agentPending: AgentPendingStore = {
    take: () => null,
  } as unknown as AgentPendingStore;
  const center = new BeInstructionCenter(
    authCfg,
    ledger,
    clock,
    sectors,
    ledgerSvc,
    stockMeta,
    watch,
    stockList,
    sentimentSvc,
    watchTaskStore,
    ta,
    screenSvc,
    llm,
    cron,
    agentSvc,
    agentHistory,
    agentPending,
  );
  const reg = new InstructionRegistry();
  const enqueued: InstructionAsyncJob[] = [];
  const asyncBus: Pick<InstructionAsyncBus, 'enqueue'> = {
    enqueue: (job) => {
      enqueued.push(job);
      return Promise.resolve();
    },
  };
  const exe = new InstructionExecutor(reg, asyncBus as unknown as InstructionAsyncBus, clock, center);
  return { exe, reg, center };
}

describe('InstructionExecutor → BeInstructionCenter intercept', () => {
  it('dispatch("usr") routes through the cell and returns rendered InstructionResult', async () => {
    const { exe } = build();
    const dispatched = await exe.dispatch('usr', {}, ctx);
    expect(dispatched.kind).toBe('sync');
    if (dispatched.kind !== 'sync') return;
    expect(dispatched.result.ok).toBe(true);
    if (!dispatched.result.ok) return;
    expect(dispatched.result.output.text).toContain('user_id');
    expect(dispatched.result.output.text).toContain('admin');
    expect(dispatched.result.output.meta).toBeDefined();
  });

  it('executeLine("usr") resolves canonical id through the center', async () => {
    const { exe } = build();
    const r = await exe.executeLine('usr', ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output.text).toContain('user_id');
  });

  it('executeLine resolves IM aliases declared in the manifest', async () => {
    const { exe } = build();
    const r = await exe.executeLine('我的', ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output.text).toContain('user_id');
  });

  it('executeHandler routes through the center for migrated ids', async () => {
    const { exe } = build();
    const r = await exe.executeHandler('usr', {}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output.text).toContain('user_id');
  });

  it('returns not-found for ids absent from both center and registry', async () => {
    const { exe } = build();
    const r = await exe.executeHandler('does.not.exist', {}, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('not-found');
  });

  it('center.has() and center.ids() reflect the migrated set', () => {
    const { center } = build();
    expect(center.has('usr')).toBe(true);
    expect(center.has('sector')).toBe(true);
    expect(center.has('sector.publish')).toBe(true);
    expect(center.has('sector.unpublish')).toBe(true);
    expect(center.has('sector.rm')).toBe(true);
    expect(center.has('ledger')).toBe(true);
    expect(center.has('stock')).toBe(true);
    expect(center.has('watch')).toBe(true);
    expect(center.has('watch.add')).toBe(true);
    expect(center.has('watch.remove')).toBe(true);
    expect(center.has('watch.group')).toBe(true);
    expect(center.has('analyze')).toBe(true);
    expect(center.has('ta')).toBe(true);
    expect(center.has('ta.sector')).toBe(true);
    expect(center.has('screen')).toBe(true);
    expect(center.has('ledger.analyze')).toBe(true);
    expect(center.has('web.search')).toBe(true);
    expect(center.has('update')).toBe(true);
    expect(center.has('sector.show')).toBe(true);
    expect(center.has('agent')).toBe(true);
    expect(center.has('agent.confirm')).toBe(true);
    expect(center.has('analyze.sector')).toBe(false);
    expect(center.ids().slice().sort()).toEqual([
      'agent',
      'agent.confirm',
      'analyze',
      'ledger',
      'ledger.add',
      'ledger.analyze',
      'ledger.remove',
      'screen',
      'sector',
      'sector.publish',
      'sector.rm',
      'sector.show',
      'sector.unpublish',
      'stock',
      'ta',
      'ta.sector',
      'update',
      'usr',
      'watch',
      'watch.add',
      'watch.group',
      'watch.remove',
      'web.search',
    ]);
  });

  it('synthesised entry inherits mode=async from the manifest → analyze enqueues instead of running sync', async () => {
    const { exe, enqueued } = (function buildWithCapture(): {
      exe: InstructionExecutor;
      enqueued: InstructionAsyncJob[];
    } {
      const authCfg = { adminUserId: 'admin' } as unknown as AuthConfig;
      const ledger: UserLlmLedgerStore = {
        summarize: () => Promise.resolve(emptySummary()),
      } as unknown as UserLlmLedgerStore;
      const clock = new FrozenClock(NOW);
      const sectors: SectorsService = { listVisibleTo: () => [] } as unknown as SectorsService;
      const ledgerSvc: LedgerService = {
        enriched: () => Promise.resolve([]),
      } as unknown as LedgerService;
      const stockMeta: StockMetaService = {
        listAll: () => Promise.resolve([]),
        snapshotAll: () => Promise.resolve([]),
      } as unknown as StockMetaService;
      const watch: WatchService = { list: () => Promise.resolve([]) } as unknown as WatchService;
      const stockList: StockListService = {
        assembleRows: () => Promise.resolve({ rows: [] }),
      } as unknown as StockListService;
      const sentimentSvc: NewsSentimentService = {
        analyzeOne: () => Promise.reject(new Error('should not be called for async path')),
        getCachedStock: () => Promise.resolve(null),
      } as unknown as NewsSentimentService;
      const watchTaskStore: WatchTaskStore = {
        deleteByIdx: () => Promise.resolve(undefined),
      } as unknown as WatchTaskStore;
      const ta: TaService = {
        analyzeOne: () => Promise.reject(new Error('not used')),
        getCached: () => Promise.resolve(null),
        analyzeSector: () => Promise.reject(new Error('not used')),
      } as unknown as TaService;
      const screenSvc: ScreenService = {
        runNl: () => Promise.reject(new Error('not used')),
      } as unknown as ScreenService;
      const llm: LlmService = {
        completeWithWebSearch: () => Promise.reject(new Error('not used')),
      } as unknown as LlmService;
      const cron: CronOrchestrator = {
        fireScan: () => ({ started: true, traceId: 'fake-trace' }),
      } as unknown as CronOrchestrator;
      const agentSvc: AgentService = {
        resolveMaxToolCalls: () => 3,
        runFresh: () => Promise.resolve(),
        resume: () => Promise.resolve(),
      } as unknown as AgentService;
      const agentHistory: AgentHistoryStore = {
        recent: () => [],
      } as unknown as AgentHistoryStore;
      const agentPending: AgentPendingStore = {
        take: () => null,
      } as unknown as AgentPendingStore;
      const center = new BeInstructionCenter(
        authCfg,
        ledger,
        clock,
        sectors,
        ledgerSvc,
        stockMeta,
        watch,
        stockList,
        sentimentSvc,
        watchTaskStore,
        ta,
        screenSvc,
        llm,
        cron,
        agentSvc,
        agentHistory,
        agentPending,
      );
      const reg = new InstructionRegistry();
      const queued: InstructionAsyncJob[] = [];
      const asyncBus: Pick<InstructionAsyncBus, 'enqueue'> = {
        enqueue: (job) => {
          queued.push(job);
          return Promise.resolve();
        },
      };
      const exeLocal = new InstructionExecutor(
        reg,
        asyncBus as unknown as InstructionAsyncBus,
        clock,
        center,
      );
      return { exe: exeLocal, enqueued: queued };
    })();
    const dispatched = await exe.dispatch('analyze', { code: '600519', fresh: false }, ctx);
    expect(dispatched.kind).toBe('async-queued');
    if (dispatched.kind === 'async-queued') {
      expect(dispatched.instructionId).toBe('analyze');
    }
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.instructionId).toBe('analyze');
  });

  it('synthesised entry forwards peekImConfirmBypass into the cell.peek hook', async () => {
    // Wire a sentiment service that reports a cache hit; the synthesised
    // handler's peekImConfirmBypass should return true.
    const authCfg = { adminUserId: 'admin' } as unknown as AuthConfig;
    const ledger: UserLlmLedgerStore = {
      summarize: () => Promise.resolve(emptySummary()),
    } as unknown as UserLlmLedgerStore;
    const clock = new FrozenClock(NOW);
    const sectors: SectorsService = { listVisibleTo: () => [] } as unknown as SectorsService;
    const ledgerSvc: LedgerService = {
      enriched: () => Promise.resolve([]),
    } as unknown as LedgerService;
    const stockMeta: StockMetaService = {
      listAll: () => Promise.resolve([]),
      snapshotAll: () => Promise.resolve([]),
    } as unknown as StockMetaService;
    const watch: WatchService = { list: () => Promise.resolve([]) } as unknown as WatchService;
    const stockList: StockListService = {
      assembleRows: () => Promise.resolve({ rows: [] }),
    } as unknown as StockListService;
    const cached = {
      code: '600519',
      score: 0.1,
      theme: 't',
      driver: 'd',
      target: 1,
      rumor: '',
      cachedAt: '2026-05-01T00:00:00.000+00:00',
      rawLog: [],
      result: '',
    };
    const sentimentSvc: NewsSentimentService = {
      analyzeOne: () => Promise.reject(new Error('not used')),
      getCachedStock: () => Promise.resolve(cached),
    } as unknown as NewsSentimentService;
    const watchTaskStore: WatchTaskStore = {
      deleteByIdx: () => Promise.resolve(undefined),
    } as unknown as WatchTaskStore;
    const ta: TaService = {
      analyzeOne: () => Promise.reject(new Error('not used')),
      getCached: () => Promise.resolve(null),
      analyzeSector: () => Promise.reject(new Error('not used')),
    } as unknown as TaService;
    const screenSvc: ScreenService = {
      runNl: () => Promise.reject(new Error('not used')),
    } as unknown as ScreenService;
    const llm: LlmService = {
      completeWithWebSearch: () => Promise.reject(new Error('not used')),
    } as unknown as LlmService;
    const cron: CronOrchestrator = {
      fireScan: () => ({ started: true, traceId: 'fake-trace' }),
    } as unknown as CronOrchestrator;
    const agentSvc: AgentService = {
      resolveMaxToolCalls: () => 3,
      runFresh: () => Promise.resolve(),
      resume: () => Promise.resolve(),
    } as unknown as AgentService;
    const agentHistory: AgentHistoryStore = {
      recent: () => [],
    } as unknown as AgentHistoryStore;
    const agentPending: AgentPendingStore = {
      take: () => null,
    } as unknown as AgentPendingStore;
    const center = new BeInstructionCenter(
      authCfg,
      ledger,
      clock,
      sectors,
      ledgerSvc,
      stockMeta,
      watch,
      stockList,
      sentimentSvc,
      watchTaskStore,
      ta,
      screenSvc,
      llm,
      cron,
      agentSvc,
      agentHistory,
      agentPending,
    );
    // Test the synthesised handler's peek directly — the IM gate uses
    // `entry.handler.peekImConfirmBypass`.
    expect(center.has('analyze')).toBe(true);
    const bypassed = await center.peekImConfirmBypass(
      'analyze',
      { code: '600519', fresh: false },
      ctx,
    );
    expect(bypassed).toBe(true);
  });

  it('center.invoke() returns typed UsrResult without going through renderer', async () => {
    const { center } = build();
    const r = await center.invoke('usr', {} as never, ctx);
    expect(r.identity.userId).toBe('admin');
    expect(r.identity.role).toBe('admin');
    expect(r.ledger).toBeNull();
  });
});
