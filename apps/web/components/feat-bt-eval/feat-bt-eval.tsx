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

import { Box, Button, Flex, Input, Text } from '@chakra-ui/react';
import type { BacktestEvaluateResponse } from '@quant/shared';
import { useMemo, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useBacktestScreen } from '../../lib/hooks/use-backtest.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from '../feat-view/feat-view.js';
import { ReturnBoxplot } from './return-boxplot.js';

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
  const mutation = useBacktestScreen();

  const holdings = parseHoldings(holdingsText);
  const validation = validate(holdings, startDate, endDate);
  const disabled = mutation.isPending || validation !== null || sector.screenPlan === undefined;

  const onRun = (): void => {
    if (disabled || sector.screenPlan === undefined) return;
    mutation.mutate({
      screenPlan: sector.screenPlan,
      universePlan: sector.universePlan ?? null,
      rank: sector.rank ?? null,
      startDate,
      endDate,
      holdings,
    });
  };
  const errorMsg = validation ?? (mutation.isError ? mutation.error.message : null);

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
        disabled={disabled}
        pending={mutation.isPending}
      />
      {errorMsg !== null && <Err msg={errorMsg} />}
      {mutation.data !== undefined && <Results data={mutation.data} />}
    </Flex>
  );
}

function validate(holdings: readonly number[], start: string, end: string): string | null {
  if (holdings.length === 0) return 'enter ≥ 1 positive integer';
  if (start.length === 10 && end.length === 10 && start > end) return 'start must be ≤ end';
  return null;
}

interface ControlsProps {
  readonly startDate: string;
  readonly endDate: string;
  readonly holdingsText: string;
  readonly onStart: (v: string) => void;
  readonly onEnd: (v: string) => void;
  readonly onHoldings: (v: string) => void;
  readonly onRun: () => void;
  readonly disabled: boolean;
  readonly pending: boolean;
}

function Controls(p: ControlsProps): React.ReactElement {
  return (
    <Flex gap="8px" align="center" wrap="wrap">
      <Field label="start" value={p.startDate} onChange={p.onStart} width="120px" />
      <Field label="end" value={p.endDate} onChange={p.onEnd} width="120px" />
      <Field
        label="holds"
        value={p.holdingsText}
        onChange={p.onHoldings}
        width="160px"
        placeholder="5,10,20,60,90"
      />
      <Button
        h="22px"
        px="10px"
        bg="accent"
        color="panel"
        borderRadius="0"
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.14em"
        fontWeight="700"
        loading={p.pending}
        disabled={p.disabled}
        onClick={p.onRun}
      >
        RUN
      </Button>
    </Flex>
  );
}

function Field({
  label,
  value,
  onChange,
  width,
  placeholder,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly width: string;
  readonly placeholder?: string;
}): React.ReactElement {
  return (
    <Flex align="center" gap="4px">
      <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.14em">
        {label}
      </Text>
      <Input
        value={value}
        onChange={(e): void => {
          onChange(e.target.value);
        }}
        placeholder={placeholder}
        h="22px"
        w={width}
        bg="panel"
        borderWidth="1px"
        borderColor="line"
        borderRadius="0"
        fontFamily="mono"
        fontSize="11px"
        color="ink"
        px="6px"
      />
    </Flex>
  );
}

function Results({ data }: { readonly data: BacktestEvaluateResponse }): React.ReactElement {
  const stats = data.summary.map((s) => ({
    label: `${String(s.holding)}d`,
    n: s.n,
    mean: s.mean,
    median: s.median,
    p05: s.p05,
    p25: s.p25,
    p75: s.p75,
    p95: s.p95,
  }));
  return (
    <Flex direction="column" gap="6px">
      <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.14em">
        // range {data.signalDateRange?.[0] ?? '—'} → {data.signalDateRange?.[1] ?? '—'} · avg
        signals/day {data.universeSizeAvg.toFixed(1)}
      </Text>
      <ReturnBoxplot stats={stats} width={420} height={220} />
      <SummaryTable data={data} />
    </Flex>
  );
}

function SummaryTable({
  data,
}: {
  readonly data: BacktestEvaluateResponse;
}): React.ReactElement {
  return (
    <Box
      as="table"
      width="100%"
      fontFamily="mono"
      fontSize="11px"
      style={{ borderCollapse: 'collapse' }}
    >
      <Box as="thead">
        <Box as="tr" color="ink3">
          {['hold', 'n', 'mean', 'median', 'win', 'p25', 'p75', 'sharpe'].map((h) => (
            <Box
              as="td"
              key={h}
              px="6px"
              py="3px"
              textAlign={h === 'hold' ? 'left' : 'right'}
              borderBottomWidth="1px"
              borderColor="line"
            >
              {h}
            </Box>
          ))}
        </Box>
      </Box>
      <Box as="tbody">
        {data.summary.map((s) => (
          <Box as="tr" key={s.holding} color="ink">
            <Box as="td" px="6px" py="3px">{s.holding}d</Box>
            <Cell num={s.n} digits={0} />
            <Cell num={s.mean} pct />
            <Cell num={s.median} pct />
            <Cell num={s.winRate} pct />
            <Cell num={s.p25} pct />
            <Cell num={s.p75} pct />
            <Cell num={s.sharpeLike} digits={2} />
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Cell({
  num,
  pct,
  digits,
}: {
  readonly num: number;
  readonly pct?: boolean;
  readonly digits?: number;
}): React.ReactElement {
  const text = pct === true ? `${(num * 100).toFixed(1)}%` : num.toFixed(digits ?? 2);
  const color = pct === true && num !== 0 ? (num > 0 ? 'up' : 'down') : 'ink';
  return (
    <Box as="td" px="6px" py="3px" textAlign="right" color={color}>
      {text}
    </Box>
  );
}

function Err({ msg }: { readonly msg: string }): React.ReactElement {
  return (
    <Text fontFamily="mono" fontSize="10px" color="up">
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
    <Text fontFamily="mono" fontSize="11px" color="ink3" letterSpacing="0.06em">
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
