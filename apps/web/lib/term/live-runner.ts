'use client';

/**
 * `LiveActionRunner` — calls the real Next.js BFF endpoints (`/api/...`)
 * for every terminal action id. Mirrors the shape and contract of
 * {@link MockActionRunner} from `@quant/terminal` so the two are
 * interchangeable at the {@link DataActionRunner} interface boundary.
 *
 * Architectural notes:
 *   - The terminal package stays pure (CLAUDE.md §2.5.1) — `fetch` and
 *     URL strings live here, in `apps/web/lib/term/`.
 *   - We reuse `MockCache` from the terminal package for the cache so
 *     read-action invalidation rules stay symmetric with the mock.
 *   - Every action result is run through `cfg.result.parse()` after
 *     projection so a server payload that drifts from the agreed shape
 *     fails loud at the boundary, not deep inside a renderer.
 *   - `watch.list` issues a one-shot `GET /api/watch` BFF call. Live
 *     updates land via the global Socket.IO bus (`watch.snapshot`).
 *
 * Toggle between mock and live via `lib/term/install-runner.ts`, which
 * inspects `localStorage['tm.runner']` and `process.env.NEXT_PUBLIC_*`.
 */

import { z } from 'zod';
import {
  enrichEntries,
  InstructionAgentDeltaPayloadSchema,
  QuantError,
  validateLedger,
  WatchTaskSchema,
  type LedgerEntry,
} from '@quant/shared';
import {
  MockCache,
  type AgentDeltaFrame,
  type DataActionConfig,
  type DataActionRunner,
  type RevalidateScope,
  type RunOpts,
  type RunOutcome,
} from '@quant/terminal';

import { sendSocketCommand, subscribeTopic } from '../socket/socket-client.js';

import { apiGet, apiPost } from '../api/client.js';
import {
  analyzeLedger,
  analyzeManySentiment,
  analyzeSentiment,
  analyzeTa,
  analyzeTaMany,
  createLedgerEntry,
  deleteLedgerEntry,
  getCachedLedgerAnalysis,
  getCachedMarketSentiment,
  getCachedSentiment,
  getCachedTaAnalysis,
  getStockMeta,
  listKline,
  listLedgerEntries,
  listStockSnapshots,
  patchLedgerEntry,
  runNlScreen,
} from '../api/endpoints.js';
import { fetchSectors, publishSector, putSectors, refreshSector } from '../api/sectors.js';
import {
  klineToTerm,
  marketSentimentToTerm,
  metaToTerm,
  screenToTerm,
  sentimentToTerm,
  snapshotToTerm,
  termGroupNameFor,
  watchToCreate,
  watchToTerm,
} from './projectors.js';
import { StockMetaDtoSchema, WatchGroupSchema } from '@quant/shared';

/**
 * Caller-supplied helpers the runner needs but doesn't own. Keeps the
 * runner free of references to React stores; the bridge (`useTerminal`)
 * wires concrete sources here.
 */
export interface LiveRunnerDeps {
  /** Looks up a stock name by code from a cached universe. */
  readonly lookupName: (code: string) => string | null;
  /**
   * Invalidate matching client-side caches (react-query keys, zustand
   * stores) so the rest of the UI reflects the write. Called after
   * successful write / paid actions per {@link REVALIDATE_AFTER}.
   * No-op default — pass a real impl from the bridge.
   */
  readonly revalidate?: (scope: RevalidateScope) => void;
}

/**
 * Per-action cache scopes to revalidate after a successful run. Keep
 * this list narrow — invalidating `'all'` from a single watch upsert
 * would re-fetch the entire EQ.LIST viewport for nothing.
 */
const REVALIDATE_AFTER: Readonly<Record<string, readonly RevalidateScope[]>> = {
  'analyze.one': ['sentiment'],
  'analyze.many': ['sentiment'],
  'analyze.ta': ['ta'],
  'analyze.ta.many': ['ta'],
  'sector.upsert': ['sectors'],
  'sector.remove': ['sectors'],
  'sector.refreshDynamic': ['sectors'],
  'sector.publish': ['sectors'],
  'watch.upsert': ['watch'],
  'watch.remove': ['watch'],
  'ledger.upsert': ['ledger'],
  'ledger.remove': ['ledger'],
  'analyze.ledger': ['ledger'],
};

type Fetcher = (args: never, signal: AbortSignal) => unknown | Promise<unknown>;

/**
 * Per-action live fetchers. Each one is responsible for projecting the
 * BFF response into the simplified shape `cfg.result.parse()` expects.
 */
function buildFetchers(deps: LiveRunnerDeps): Record<string, Fetcher> {
  return {
    'stock.list': async (_a, signal: AbortSignal) => {
      const list = await apiGet('/api/stocks', (raw) => z.array(StockMetaDtoSchema).parse(raw), {
        signal,
      });
      return list.map(metaToTerm);
    },

    'stock.info': async ({ code }: { code: string }) => {
      const m = await getStockMeta(code);
      if (m === null) {
        throw new QuantError('STOCK_NOT_FOUND', `stock ${code} not found`);
      }
      return metaToTerm(m);
    },

    'stock.kline': async ({ code, range }: { code: string; range: string }) => {
      const bars = await listKline(code, range);
      return bars.map(klineToTerm);
    },

    'stock.snapshots': async ({ codes }: { codes: readonly string[] }) => {
      const snaps = await listStockSnapshots(codes);
      return snaps.map(snapshotToTerm);
    },

    'sector.list': async () => {
      const sectors = await fetchSectors();
      // Shared Sector and terminal Sector are the same shape — pass through.
      return sectors;
    },

    'sector.show': async ({ idOrName }: { idOrName: string }) => {
      const sectors = await fetchSectors();
      const lower = idOrName.toLowerCase();
      const found = sectors.find(
        (s) => s.id.toLowerCase() === lower || s.name.toLowerCase() === lower,
      );
      if (found === undefined) {
        throw new QuantError('NOT_FOUND', `sector ${idOrName} not found`);
      }
      return found;
    },

    'sector.upsert': async ({ sector }: { sector: Parameters<typeof putSectors>[0][number] }) => {
      const all = await fetchSectors();
      const existing = all.findIndex((s) => s.id === sector.id);
      const next =
        existing >= 0 ? all.map((s, i) => (i === existing ? sector : s)) : [...all, sector];
      const saved = await putSectors(next);
      const ret = saved.find((s) => s.id === sector.id);
      if (ret === undefined) {
        throw new QuantError('INTERNAL', 'sector upsert: not in response');
      }
      return ret;
    },

    'sector.remove': async ({ idOrName }: { idOrName: string }) => {
      const all = await fetchSectors();
      const lower = idOrName.toLowerCase();
      const next = all.filter(
        (s) => s.id.toLowerCase() !== lower && s.name.toLowerCase() !== lower,
      );
      if (next.length === all.length) {
        throw new QuantError('NOT_FOUND', `sector ${idOrName} not found`);
      }
      await putSectors(next);
      return { idOrName };
    },

    'sector.refreshDynamic': async ({ idOrName }: { idOrName: string }) => {
      const all = await fetchSectors();
      const lower = idOrName.toLowerCase();
      const cur = all.find((s) => s.id.toLowerCase() === lower || s.name.toLowerCase() === lower);
      if (cur === undefined) {
        throw new QuantError('NOT_FOUND', `sector ${idOrName} not found`);
      }
      if (cur.kind !== 'dynamic') {
        throw new QuantError('INVALID_ARGUMENT', `sector ${idOrName} is not a dynamic sector`);
      }
      // Server-side refresh (re-runs screenPlan, persists for everyone). Falls
      // back to client-side NL → DSL → PUT if the sector pre-dates screenPlan.
      if (cur.screenPlan !== undefined) {
        return refreshSector(cur.id);
      }
      if (cur.nl === undefined) {
        throw new QuantError('INVALID_ARGUMENT', `sector ${idOrName} has no nl/screenPlan`);
      }
      const screen = await runNlScreen(cur.nl);
      const codes = screen.matches.map((m) => m.code);
      const refreshed = { ...cur, codes, count: codes.length };
      const next = all.map((s) => (s.id === cur.id ? refreshed : s));
      const saved = await putSectors(next);
      const ret = saved.find((s) => s.id === cur.id);
      if (ret === undefined) {
        throw new QuantError('INTERNAL', 'sector refresh: not in response');
      }
      return ret;
    },

    'sector.publish': async ({ id, published }: { id: string; published: boolean }) => {
      return publishSector(id, published);
    },

    'analyze.one': async ({ code, force }: { code: string; force?: boolean }) => {
      // Cached read first when not forced; on miss or force, hit the
      // paid POST. Mirrors mock semantics.
      if (force !== true) {
        const cached = await getCachedSentiment(code);
        if (cached !== null) return sentimentToTerm(cached);
      }
      const fresh = await analyzeSentiment(code);
      return sentimentToTerm(fresh);
    },

    'analyze.many': async ({ codes, force }: { codes: readonly string[]; force?: boolean }) => {
      if (force !== true) {
        const cached = await getCachedMarketSentiment(codes);
        if (cached !== null) return marketSentimentToTerm(cached, codes);
      }
      const fresh = await analyzeManySentiment(codes);
      return marketSentimentToTerm(fresh, codes);
    },

    'analyze.ta': async ({ code, force }: { code: string; force?: boolean }) => {
      // Cached read first when not forced; on miss or force, hit the
      // paid POST. Result is the shared `TaAnalysis` shape directly —
      // no projector layer because the schema is already action-friendly.
      if (force !== true) {
        const cached = await getCachedTaAnalysis(code);
        if (cached !== null) return cached;
      }
      return analyzeTa(code, force === true);
    },

    'analyze.ta.many': async ({
      codes,
      label,
    }: {
      codes: readonly string[];
      label?: string;
      force?: boolean;
    }) => {
      // Per-stock TA fan-out happens server-side; each member call hits
      // the existing `analyze_ta_one` cache, so a sector with warm
      // members is fast even on the first call.
      return analyzeTaMany(codes, label);
    },

    'screen.nl': async ({ nl, asof }: { nl: string; asof?: string }) => {
      const r = await runNlScreen(nl, asof);
      return screenToTerm(r, deps.lookupName);
    },

    'watch.list': async () => {
      const tasks = await apiGet('/api/watch', (raw) => z.array(WatchTaskSchema).parse(raw));
      return tasks.map(watchToTerm);
    },

    'watch.upsert': async ({ task }: { task: ReturnType<typeof watchToTerm> }) => {
      // Ensure a group exists for these conds; idempotent — 409 means
      // the group already exists with the same conds (deterministic
      // hash), which is exactly what we want.
      const groupName = termGroupNameFor(task);
      const groupBody = {
        name: groupName,
        conditions: task.conditions,
        intervalSec: Math.max(5, task.intervalSec),
        pushIntervalSec: Math.max(60, task.pushIntervalSec),
      };
      const groupRes = await fetch('/api/watch/groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(groupBody),
      });
      if (!groupRes.ok && groupRes.status !== 409) {
        throw new Error(`watch group create failed: ${String(groupRes.status)}`);
      }
      // Validate the persisted group shape if a fresh create succeeded.
      if (groupRes.ok) {
        WatchGroupSchema.parse(await groupRes.json());
      }
      const body = watchToCreate(task, groupName);
      const saved = await apiPost('/api/watch', body, (raw) => WatchTaskSchema.parse(raw));
      return watchToTerm(saved);
    },

    'watch.remove': async ({ market, code }: { market: 'a' | 'hk' | 'us'; code: string }) => {
      const res = await fetch(`/api/watch/${market}/${encodeURIComponent(code)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new QuantError('WATCH_CODE_NOT_FOUND', `watch ${market}/${code} not found`);
      }
      return { market, code };
    },

    'ledger.list': async () => {
      const entries = await listLedgerEntries();
      const validation = validateLedger(entries);
      if (!validation.ok) {
        // Server-validated; should never happen unless someone hand-edited
        // the JSON file under our feet. Surface so the user can fix it.
        throw new QuantError(validation.error.code, validation.error.message);
      }
      return enrichEntries(entries);
    },

    'ledger.upsert': async ({ entry }: { entry: LedgerEntry }) => {
      // Try create first; if the date already exists, fall through to PATCH.
      try {
        return await createLedgerEntry(entry);
      } catch {
        const body: { pnlAmount?: string; closingPosition?: string | null } = {
          pnlAmount: entry.pnlAmount,
        };
        if (entry.closingPosition !== undefined) {
          body.closingPosition = entry.closingPosition ?? null;
        } else {
          body.closingPosition = null;
        }
        return patchLedgerEntry(entry.date, body);
      }
    },

    'ledger.remove': async ({ date }: { date: string }) => {
      await deleteLedgerEntry(date);
      return { date };
    },

    'analyze.ledger': async ({ force }: { force?: boolean }) => {
      if (force !== true) {
        const cached = await getCachedLedgerAnalysis();
        if (cached !== null) return cached;
      }
      return analyzeLedger(force === true);
    },

    'user.me': async (_a, signal: AbortSignal) => {
      // The BFF's /api/auth/me returns the resolved AuthenticatedUser
      // verbatim; we project it into the action's UserMe shape (admin
      // role inferred from id === 'admin' so the terminal doesn't have
      // to know the configured admin id).
      const me = await apiGet(
        '/api/auth/me',
        (raw) =>
          z
            .object({
              id: z.string().min(1),
              displayName: z.string(),
              source: z.enum(['oauth', 'env', 'im']),
              imBootstrap: z.boolean(),
              originalUserId: z.string().optional(),
            })
            .parse(raw),
        { signal },
      );
      return {
        userId: me.id,
        displayName: me.displayName,
        role: me.id === 'admin' ? ('admin' as const) : ('user' as const),
        source: me.source,
        imBootstrap: me.imBootstrap,
        ...(me.originalUserId !== undefined ? { originalUserId: me.originalUserId } : {}),
      };
    },
  };
}

export class LiveActionRunner implements DataActionRunner {
  readonly id = 'live' as const;
  private readonly cache: MockCache;
  private readonly fetchers: Record<string, Fetcher>;
  private readonly deps: LiveRunnerDeps;

  constructor(deps: LiveRunnerDeps, cache: MockCache = new MockCache()) {
    this.cache = cache;
    this.deps = deps;
    this.fetchers = buildFetchers(deps);
  }

  async run<A, R>(cfg: DataActionConfig<A, R>, args: A, opts: RunOpts): Promise<RunOutcome<R>> {
    if (opts.signal.aborted) {
      throw new QuantError('INTERNAL', 'aborted');
    }
    const validated = cfg.args.parse(args) as A;

    if (cfg.kind === 'read' && cfg.cacheKey !== undefined && opts.forceFresh !== true) {
      const cached = this.cache.get(cfg.cacheKey(validated));
      if (cached !== undefined) {
        return { data: cached as R, cached: true };
      }
    }

    const fetcher = this.fetchers[cfg.id];
    if (fetcher === undefined) {
      throw new QuantError('INTERNAL', `no live fetcher for action ${cfg.id}`);
    }
    const result = await (fetcher as (a: unknown, s: AbortSignal) => unknown | Promise<unknown>)(
      validated,
      opts.signal,
    );
    const parsed = cfg.result.parse(result) as R;

    if (cfg.kind === 'read' && cfg.cacheKey !== undefined) {
      this.cache.set(cfg.cacheKey(validated), parsed);
    }
    if (cfg.kind !== 'read' && cfg.invalidates !== undefined) {
      for (const prefix of cfg.invalidates(validated)) {
        this.cache.invalidate(prefix);
      }
    }
    // Cross-cache revalidation for write / paid actions — invalidates
    // react-query keys / zustand stores in the rest of the app so the
    // EQ.LIST, sentiment panels, etc. pick up the change without a
    // page refresh.
    const revalidate = this.deps.revalidate;
    if (revalidate !== undefined) {
      const scopes = REVALIDATE_AFTER[cfg.id];
      if (scopes !== undefined) {
        for (const scope of scopes) revalidate(scope);
      }
    }
    return { data: parsed, cached: false };
  }

  invalidate(prefix: readonly (string | number | boolean)[]): void {
    this.cache.invalidate(prefix);
  }

  stats(): { entries: number; hits: number; misses: number } {
    return this.cache.stats();
  }

  // /agent socket bridge — wired to the singleton socket-client. The
  // optional methods are declared on `DataActionRunner`; mock runners
  // omit them, so the term command is expected to null-check.
  invokeBeInstruction = async (
    id: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly jobId: string; readonly text: string; readonly ok: boolean }> => {
    const ack = await sendSocketCommand({ id, args });
    const detail = (ack.detail as { text?: unknown } | undefined) ?? undefined;
    const text = typeof detail?.text === 'string' ? detail.text : '';
    // Try to extract jobId from the agent handler's "▶ /agent ... jobId=<uuid>" text.
    const jobIdMatch = /jobId=([0-9a-f-]{36})/u.exec(text);
    const jobId = jobIdMatch !== null ? (jobIdMatch[1] ?? '') : '';
    return { jobId, text, ok: ack.ok };
  };

  subscribeAgentDelta = (
    jobId: string,
    onFrame: (frame: AgentDeltaFrame) => void,
  ): (() => void) => {
    return subscribeTopic('instruction.agent.delta', (raw: unknown) => {
      const parsed = InstructionAgentDeltaPayloadSchema.safeParse(raw);
      if (!parsed.success) return;
      if (parsed.data.jobId !== jobId) return;
      // Width the schema to the runner-local frame type.
      onFrame(parsed.data as unknown as AgentDeltaFrame);
    });
  };
}
