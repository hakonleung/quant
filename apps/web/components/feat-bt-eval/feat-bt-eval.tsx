'use client';

/**
 * BT.EVAL — event-study backtest on the active dynamic sector's screen.
 *
 * Inputs: date window (default = last 250 calendar days ending today)
 * + holdings list (default 5 / 10 / 20 / 60 / 90 trading days). Run
 * button POSTs `/api/backtest/evaluate-screen`; NestJS iterates the
 * trading days, ships signals + klines to Python, returns the per-
 * holding return distribution.
 *
 * Visible only when the active sector is a dynamic one with a parsed
 * screenPlan — there is nothing to backtest otherwise.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type {
  BacktestEvaluateResponse,
  BacktestEvaluateScreenRequest,
  BacktestSpreadSummary,
} from '@quant/shared';
import { useMemo, useState } from 'react';

import type { ScreenProgressEvent } from '../../lib/api/backtest-stream.js';
import { Feat } from '../../lib/eqty/feat.js';
import { useBacktestScreen, useBacktestScreenCached } from '../../lib/hooks/use-backtest.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from '../feat-view/feat-view.js';
import { Controls } from './controls.js';
import { ObservationsPanel } from './observations-panel.js';
import { ReturnDistributionStack } from './return-distribution-stack.js';
import { SummaryTable } from './summary-table.js';

const DEFAULT_HOLDINGS = '5,10,20,60,90';
const DEFAULT_WINDOW_DAYS = 250;

export function FeatBtEval(): React.ReactElement {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const sectors = useSectorsStore((s) => s.sectors);
  const sector = sectors.find((s) => s.id === activeSectorId) ?? null;
  const canRun =
    sector !== null && sector.kind === 'dynamic' && sector.screenPlan !== undefined;

  return (
    <FeatView feat={Feat.BtEval} status={canRun ? 'green' : 'amber'}>
      <Box px="10px" py="8px">
        {canRun ? <Runner sector={sector} /> : <EmptyHint sector={sector} />}
      </Box>
    </FeatView>
  );
}

function Runner({ sector }: { sector: Sector }): React.ReactElement {
  const initial = useMemo(() => defaultDateWindow(), []);
  const [startDate, setStartDate] = useState(initial.start);
  const [endDate, setEndDate] = useState(initial.end);
  const [holdingsText, setHoldingsText] = useState(DEFAULT_HOLDINGS);
  const { mutation, progress, cancel } = useBacktestScreen();

  const holdings = parseHoldings(holdingsText);
  const validation = validate(holdings, startDate, endDate);
  const req = useScreenRequest(sector, validation, startDate, endDate, holdings);
  const cached = useBacktestScreenCached(req, !mutation.isPending);

  const onRun = (): void => {
    if (req !== null && !mutation.isPending) mutation.mutate(req);
  };
  const display = pickDisplay(mutation, cached);
  const errorMsg = pickError(validation, mutation, cached);

  return (
    <Flex direction="column" gap="8px">
      <Controls
        startDate={startDate}
        endDate={endDate}
        holdingsText={holdingsText}
        onStart={setStartDate}
        onEnd={setEndDate}
        onHoldings={setHoldingsText}
        onRun={onRun}
        onCancel={mutation.isPending ? cancel : null}
        disabled={mutation.isPending || req === null}
        pending={mutation.isPending}
        cacheState={cacheStateLabel(cached, mutation, display)}
      />
      {mutation.isPending && progress !== null && <ProgressBar progress={progress} />}
      {errorMsg !== null && <Err msg={errorMsg} />}
      {display !== null && <Results data={display} />}
    </Flex>
  );
}

function pickDisplay(
  mutation: { readonly data?: BacktestEvaluateResponse | undefined },
  cached: { readonly data?: BacktestEvaluateResponse | null | undefined },
): BacktestEvaluateResponse | null {
  return mutation.data ?? cached.data ?? null;
}

function pickError(
  validation: string | null,
  mutation: { readonly isError: boolean; readonly error: Error | null },
  cached: { readonly isError: boolean; readonly error: Error | null },
): string | null {
  if (validation !== null) return validation;
  if (mutation.isError && mutation.error !== null) return mutation.error.message;
  if (cached.isError && cached.error !== null) return cached.error.message;
  return null;
}

/** Build the shared request identity once per input change. */
function useScreenRequest(
  sector: Sector,
  validation: string | null,
  startDate: string,
  endDate: string,
  holdings: readonly number[],
): BacktestEvaluateScreenRequest | null {
  return useMemo(() => {
    if (validation !== null || sector.screenPlan === undefined) return null;
    return {
      screenPlan: sector.screenPlan,
      universePlan: sector.universePlan ?? null,
      rank: sector.rank ?? null,
      startDate,
      endDate,
      holdings: [...holdings],
    };
  }, [
    sector.screenPlan,
    sector.universePlan,
    sector.rank,
    startDate,
    endDate,
    holdings,
    validation,
  ]);
}

/**
 * Status chip text shown next to RUN so users know whether the numbers
 * come from cache or a fresh run. "live" after a RUN completes,
 * "cache" when the on-mount lookup hit, "no cache" on 404, "…" while
 * the lookup is still in flight.
 */
function cacheStateLabel(
  cached: {
    readonly data?: BacktestEvaluateResponse | null | undefined;
    readonly isFetching: boolean;
  },
  mutation: { readonly data?: BacktestEvaluateResponse | undefined },
  display: BacktestEvaluateResponse | null,
): string {
  if (mutation.data !== undefined && display === mutation.data) return 'live';
  if (cached.isFetching) return '…';
  if (cached.data === null || cached.data === undefined) return 'no cache';
  return 'cache';
}

function ProgressBar({ progress }: { readonly progress: ScreenProgressEvent }): React.ReactElement {
  const pct = progress.totalDays === 0 ? 0 : (progress.runDays / progress.totalDays) * 100;
  const phaseLabel = progress.phase === 'flight' ? 'aggregating' : `screening ${progress.day ?? ''}`;
  return (
    <Flex direction="column" gap="2px">
      <Text fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.06em">
        // {phaseLabel} · {String(progress.runDays)}/{String(progress.totalDays)} weekdays ·
        {' '}
        {String(progress.matchedDays)} matched · {String(progress.signals)} signals
      </Text>
      <Box h="3px" bg="line">
        <Box h="3px" bg="accent" w={`${pct.toFixed(1)}%`} transition="width 120ms linear" />
      </Box>
    </Flex>
  );
}

function validate(holdings: readonly number[], start: string, end: string): string | null {
  if (holdings.length === 0) return 'enter ≥ 1 positive integer';
  if (start.length === 10 && end.length === 10 && start > end) return 'start must be ≤ end';
  return null;
}

function Results({ data }: { readonly data: BacktestEvaluateResponse }): React.ReactElement {
  const baselineByHolding = useMemo(() => {
    const map: Record<number, number> = {};
    for (const b of data.baselineSummary ?? []) map[b.holding] = b.universeMean;
    return map;
  }, [data.baselineSummary]);
  const spreadByHolding = useMemo(() => {
    const map: Record<number, BacktestSpreadSummary> = {};
    for (const s of data.spreadSummary ?? []) map[s.holding] = s;
    return map;
  }, [data.spreadSummary]);
  const [expandedHolding, setExpandedHolding] = useState<number | null>(null);
  return (
    <Flex direction="column" gap="6px">
      <Text fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.14em">
        // 信号区间 {data.signalDateRange?.[0] ?? '—'} → {data.signalDateRange?.[1] ?? '—'} ·
        平均每日信号 {data.universeSizeAvg.toFixed(1)} 个 · 琥珀色虚线 = 全市场基准均值
      </Text>
      <ReturnDistributionStack
        summary={data.summary}
        observations={data.observations}
        baselineByHolding={baselineByHolding}
        spreadByHolding={spreadByHolding}
      />
      <SummaryTable
        data={data}
        spreadByHolding={spreadByHolding}
        expandedHolding={expandedHolding}
        onToggleHolding={(h): void => {
          setExpandedHolding((prev) => (prev === h ? null : h));
        }}
      />
      {expandedHolding !== null && (
        <ObservationsPanel
          observations={data.observations.filter((o) => o.holding === expandedHolding)}
          holding={expandedHolding}
        />
      )}
    </Flex>
  );
}

function Err({ msg }: { readonly msg: string }): React.ReactElement {
  return (
    <Text fontFamily="mono" fontSize="xs" color="up">
      // {msg}
    </Text>
  );
}

function EmptyHint({ sector }: { sector: Sector | null }): React.ReactElement {
  const hint =
    sector === null
      ? 'no sector selected'
      : sector.kind !== 'dynamic'
        ? 'pick a dynamic sector'
        : 'sector has no parsed screen plan';
  return (
    <Text fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.06em">
      // {hint}
    </Text>
  );
}

// --- helpers ---------------------------------------------------------------

function parseHoldings(text: string): number[] {
  const out: number[] = [];
  for (const piece of text.split(/[,\s]+/)) {
    const n = Number.parseInt(piece, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function defaultDateWindow(): { start: string; end: string } {
  // Past `DEFAULT_WINDOW_DAYS` calendar days. The component does not
  // need wall-clock precision; using Date here for pure arithmetic is
  // consistent with the kline reader's date math (no Clock injection
  // required for "today minus N days").
  // eslint-disable-next-line no-restricted-globals -- pure UTC arithmetic, not a clock read with side effects
  const todayMs = Date.now();
  const startMs = todayMs - DEFAULT_WINDOW_DAYS * 86_400_000;
  return { start: msToIso(startMs), end: msToIso(todayMs) };
}

function msToIso(ms: number): string {
  // eslint-disable-next-line no-restricted-globals -- pure ms → ISO conversion
  const d = new Date(ms);
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}
