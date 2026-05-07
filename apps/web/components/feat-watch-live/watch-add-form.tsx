'use client';

/**
 * Inline add-form for the Watch pane.
 *
 * Persistent at the top of the pane: user picks N stocks via the M-0
 * search (chips), shares one condition list across them, submits — one
 * task per stock. On success the form resets to its initial defaults.
 *
 * The optional `initial` prop is used by the "override" flow: a group
 * of existing tasks is deleted and their stocks/conditions are pushed
 * back into this form for editing.
 *
 * v0 only POSTs sequentially via the BFF — no dedicated batch endpoint.
 */

import { Box, Flex, Input, Text } from '@chakra-ui/react';
import {
  WATCH_TREND_WINDOW_MAX_SEC,
  WatchTaskCreateSchema,
  type WatchBaseline,
  type WatchCondition,
  type WatchMarket,
  type WatchTaskCreate,
} from '@quant/shared';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

import type { UniverseStock } from '../../lib/hooks/use-stock-universe.js';
import { useStockUniverse } from '../../lib/hooks/use-stock-universe.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { FeatScrNl } from '../feat-scr-nl/feat-scr-nl.js';
import { MonoButton } from '../ui/mono-button.js';
import { TermSelect } from './term-select.js';

const KindSchema = z.enum(['pct', 'abs']);
type Kind = z.infer<typeof KindSchema>;
const OpSchema = z.enum(['gte', 'lte']);
type Op = z.infer<typeof OpSchema>;

const KIND_ITEMS = [
  { label: 'pct', value: 'pct' as const },
  { label: 'abs', value: 'abs' as const },
];
const BASELINE_ITEMS = [
  { label: 'prev_close', value: 'prev_close' as const },
  { label: 'day_high', value: 'day_high' as const },
  { label: 'day_low', value: 'day_low' as const },
  { label: 'vwap', value: 'vwap' as const },
  { label: 'trend', value: 'trend' as const },
];
const OP_ITEMS = [
  { label: '≥', value: 'gte' as const },
  { label: '≤', value: 'lte' as const },
];
/** Default trend lookback in **seconds** (1 minute). */
const DEFAULT_TREND_WINDOW_SEC = 60;

const INPUT_STYLE = {
  bg: 'term.bg' as const,
  borderColor: 'term.line' as const,
  color: 'term.ink' as const,
  fontFamily: 'mono' as const,
  fontSize: '12px',
  h: '24px',
  px: '6px',
};

export interface PickedStock {
  readonly market: WatchMarket;
  readonly code: string;
  readonly name: string;
}

interface ConditionDraft {
  readonly kind: Kind;
  readonly baseline: WatchBaseline;
  readonly thresholdPct: string;
  readonly op: Op;
  readonly thresholdPrice: string;
  /** Trend lookback in **seconds**; only used when baseline === 'trend'. */
  readonly windowSec: string;
}

interface AddFormState {
  readonly picked: readonly PickedStock[];
  readonly conditions: readonly ConditionDraft[];
  /** Display unit on the form is minutes; the wire format is seconds. */
  readonly intervalMin: string;
  /** Same — minutes on form, seconds on wire. */
  readonly pushIntervalMin: string;
}

const INITIAL_CONDITION: ConditionDraft = {
  kind: 'pct',
  baseline: 'prev_close',
  thresholdPct: '5',
  op: 'gte',
  thresholdPrice: '100',
  windowSec: String(DEFAULT_TREND_WINDOW_SEC),
};

const INITIAL_STATE: AddFormState = {
  picked: [],
  conditions: [INITIAL_CONDITION],
  intervalMin: '1',
  pushIntervalMin: '5',
};

function secondsToMinuteString(secs: number): string {
  if (secs % 60 === 0) return String(secs / 60);
  return (secs / 60).toFixed(2);
}

function minuteStringToSeconds(min: string): number {
  return Math.round(Number(min) * 60);
}

export interface WatchAddInitial {
  readonly picked: readonly PickedStock[];
  readonly conditions: readonly WatchCondition[];
  readonly intervalSec: number;
  readonly pushIntervalSec: number;
}

function fromCondition(c: WatchCondition): ConditionDraft {
  if (c.kind === 'pct') {
    return {
      kind: 'pct',
      baseline: c.baseline,
      thresholdPct: c.thresholdPct,
      op: c.op,
      thresholdPrice: '100',
      windowSec: c.window === undefined ? String(DEFAULT_TREND_WINDOW_SEC) : String(c.window),
    };
  }
  return {
    kind: 'abs',
    baseline: 'prev_close',
    thresholdPct: '5',
    op: c.op,
    thresholdPrice: c.thresholdPrice,
    windowSec: String(DEFAULT_TREND_WINDOW_SEC),
  };
}

function buildInitialState(initial: WatchAddInitial | undefined): AddFormState {
  if (!initial) return INITIAL_STATE;
  return {
    picked: initial.picked,
    conditions:
      initial.conditions.length > 0 ? initial.conditions.map(fromCondition) : [INITIAL_CONDITION],
    intervalMin: secondsToMinuteString(initial.intervalSec),
    pushIntervalMin: secondsToMinuteString(initial.pushIntervalSec),
  };
}

function toCondition(c: ConditionDraft): WatchCondition {
  if (c.kind === 'pct') {
    if (c.baseline === 'trend') {
      const w = Math.max(
        1,
        Math.min(WATCH_TREND_WINDOW_MAX_SEC, Math.round(Number(c.windowSec) || 0)),
      );
      return {
        kind: 'pct',
        baseline: 'trend',
        op: c.op,
        thresholdPct: c.thresholdPct,
        window: w,
      };
    }
    return { kind: 'pct', baseline: c.baseline, op: c.op, thresholdPct: c.thresholdPct };
  }
  return { kind: 'abs', op: c.op, thresholdPrice: c.thresholdPrice };
}

function buildDraft(s: AddFormState, stock: PickedStock): WatchTaskCreate {
  return WatchTaskCreateSchema.parse({
    market: stock.market,
    code: stock.code,
    name: stock.name,
    conditions: s.conditions.map(toCondition),
    intervalSec: minuteStringToSeconds(s.intervalMin),
    pushIntervalSec: minuteStringToSeconds(s.pushIntervalMin),
  });
}

interface AddFormProps {
  readonly initial?: WatchAddInitial;
}

async function postOne(stock: PickedStock, state: AddFormState): Promise<string | null> {
  const draft = buildDraft(state, stock);
  const res = await fetch('/api/watch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
  if (res.ok) return null;
  const body = await res.text();
  return `[${stock.market}] ${stock.code} → ${String(res.status)} ${body.slice(0, 100)}`;
}

async function postBatch(state: AddFormState): Promise<readonly string[]> {
  const errs: string[] = [];
  for (const stock of state.picked) {
    try {
      const failure = await postOne(stock, state);
      if (failure !== null) errs.push(failure);
    } catch (e) {
      errs.push(`[${stock.market}] ${stock.code}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return errs;
}

export function WatchAddForm({ initial }: AddFormProps): React.ReactElement {
  const [state, setState] = useState<AddFormState>(() => buildInitialState(initial));
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<readonly string[]>([]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setErrs([]);
    try {
      const failures = await postBatch(state);
      if (failures.length === 0) setState(INITIAL_STATE);
      else setErrs(failures);
    } catch (e) {
      setErrs([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      mb="10px"
      p="8px"
      border="1px solid"
      borderColor="term.line"
      bg="term.bgElev"
      color="term.ink2"
    >
      <PickRow state={state} setState={setState} />
      <ConditionsList state={state} setState={setState} />
      <SubmitRow
        state={state}
        setState={setState}
        busy={busy}
        canSubmit={state.picked.length > 0 && state.conditions.length > 0}
        onSubmit={(): void => {
          void submit();
        }}
      />
      {errs.length > 0 ? (
        <Box mt="6px">
          {errs.map((e, i) => (
            <Text key={`err-${String(i)}`} color="term.red" fontSize="11px">
              {e}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

interface RowProps {
  readonly state: AddFormState;
  readonly setState: React.Dispatch<React.SetStateAction<AddFormState>>;
}

interface SectorImportRowProps {
  readonly onBatchPick: (stocks: readonly UniverseStock[]) => void;
}

function SectorImportRow({ onBatchPick }: SectorImportRowProps): React.ReactElement | null {
  const sectors = useSectorsStore((s) => s.sectors);
  const { data: universe } = useStockUniverse('a');
  const codeToStock = useMemo(() => {
    const m = new Map<string, UniverseStock>();
    for (const s of universe) if (s.market === 'a') m.set(s.code, s);
    return m;
  }, [universe]);
  const onImport = (sector: Sector): void => {
    const stocks: UniverseStock[] = [];
    for (const c of sector.codes) {
      const hit = codeToStock.get(c);
      if (hit !== undefined) stocks.push(hit);
    }
    if (stocks.length > 0) onBatchPick(stocks);
  };
  // Alt+1…9 (or Alt+0 for the 10th) imports the i-th sector. Skips
  // when focus is in a text input so the shortcut doesn't fight typing.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const target = e.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const digit = e.key === '0' ? 9 : Number.parseInt(e.key, 10) - 1;
      if (Number.isNaN(digit) || digit < 0 || digit >= sectors.length) return;
      e.preventDefault();
      const sec = sectors[digit];
      if (sec !== undefined) onImport(sec);
    };
    window.addEventListener('keydown', handler);
    return (): void => {
      window.removeEventListener('keydown', handler);
    };
  }, [sectors, codeToStock]);
  if (sectors.length === 0) return null;
  return (
    <Flex gap="4px" wrap="wrap" align="center" mb="6px">
      <Text fontSize="11px" color="term.ink3" letterSpacing="0.14em" mr="2px">
        SECTOR
      </Text>
      {sectors.map((sec, idx) => (
        <MonoButton
          key={sec.id}
          icon="add"
          label={`import ${String(sec.codes.length)} stocks from ${sec.name} (alt+${String(idx + 1)})`}
          onClick={(): void => {
            onImport(sec);
          }}
        >
          {sec.name} ({sec.codes.length})
        </MonoButton>
      ))}
    </Flex>
  );
}

function PickRow({ state, setState }: RowProps): React.ReactElement {
  const onPick = (s: UniverseStock): void => {
    setState((prev) => {
      if (prev.picked.some((p) => p.market === s.market && p.code === s.code)) return prev;
      const next: PickedStock = { market: s.market, code: s.code, name: s.name };
      return { ...prev, picked: [...prev.picked, next] };
    });
  };
  const onBatchPick = (stocks: readonly UniverseStock[]): void => {
    setState((prev) => {
      const seen = new Set(prev.picked.map((p) => `${p.market}:${p.code}`));
      const next: PickedStock[] = [...prev.picked];
      for (const s of stocks) {
        const key = `${s.market}:${s.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ market: s.market, code: s.code, name: s.name });
      }
      return { ...prev, picked: next };
    });
  };
  const onRemove = (idx: number): void => {
    setState((prev) => ({ ...prev, picked: prev.picked.filter((_, i) => i !== idx) }));
  };
  return (
    <Box>
      <SectorImportRow onBatchPick={onBatchPick} />
      <FeatScrNl onPick={onPick} onBatchPick={onBatchPick} />
      {state.picked.length === 0 ? (
        <Text mt="4px" fontSize="11px" color="term.ink3">
          search and pick one or more stocks · same condition applies to all
        </Text>
      ) : (
        <Flex mt="4px" gap="4px" wrap="wrap">
          {state.picked.map((p, i) => (
            <Flex
              key={`${p.market}:${p.code}`}
              align="center"
              gap="4px"
              px="6px"
              py="2px"
              border="1px solid"
              borderColor="term.green"
              color="term.green"
              fontFamily="mono"
              fontSize="11px"
            >
              <Text>
                [{p.market}] {p.code} · {p.name}
              </Text>
              <MonoButton
                icon="delete"
                label={`remove ${p.code}`}
                onClick={(): void => {
                  onRemove(i);
                }}
              />
            </Flex>
          ))}
        </Flex>
      )}
    </Box>
  );
}

function ConditionsList({ state, setState }: RowProps): React.ReactElement {
  const onAdd = (): void => {
    setState((prev) => ({ ...prev, conditions: [...prev.conditions, INITIAL_CONDITION] }));
  };
  const onRemove = (idx: number): void => {
    setState((prev) => {
      if (prev.conditions.length <= 1) return prev;
      return { ...prev, conditions: prev.conditions.filter((_, i) => i !== idx) };
    });
  };
  const onChange = (idx: number, next: ConditionDraft): void => {
    setState((prev) => ({
      ...prev,
      conditions: prev.conditions.map((c, i) => (i === idx ? next : c)),
    }));
  };
  return (
    <Box mt="6px">
      <Flex justify="space-between" align="center" mb="4px">
        <Text fontSize="11px" color="term.ink3" letterSpacing="0.14em">
          CONDITIONS · ANY-OF
        </Text>
        <MonoButton icon="add" label="add condition" onClick={onAdd}>
          add
        </MonoButton>
      </Flex>
      <Flex direction="column" gap="4px">
        {state.conditions.map((c, i) => (
          <ConditionRow
            key={`cond-${String(i)}`}
            cond={c}
            canRemove={state.conditions.length > 1}
            onChange={(next): void => {
              onChange(i, next);
            }}
            onRemove={(): void => {
              onRemove(i);
            }}
          />
        ))}
      </Flex>
    </Box>
  );
}

interface ConditionRowProps {
  readonly cond: ConditionDraft;
  readonly canRemove: boolean;
  readonly onChange: (next: ConditionDraft) => void;
  readonly onRemove: () => void;
}

function ConditionRow({
  cond,
  canRemove,
  onChange,
  onRemove,
}: ConditionRowProps): React.ReactElement {
  return (
    <Flex gap="6px" wrap="wrap" align="center">
      <TermSelect<Kind>
        value={cond.kind}
        items={KIND_ITEMS}
        width="76px"
        onChange={(v): void => {
          onChange({ ...cond, kind: v });
        }}
      />
      {cond.kind === 'pct' ? (
        <>
          <TermSelect<WatchBaseline>
            value={cond.baseline}
            items={BASELINE_ITEMS}
            width="130px"
            onChange={(v): void => {
              onChange({ ...cond, baseline: v });
            }}
          />
          {cond.baseline === 'trend' ? (
            <Flex align="center" gap="2px">
              <Input
                {...INPUT_STYLE}
                w="60px"
                placeholder="window"
                value={cond.windowSec}
                onChange={(e): void => {
                  onChange({ ...cond, windowSec: e.target.value });
                }}
              />
              <Text color="term.ink3" fontSize="11px">
                s
              </Text>
            </Flex>
          ) : null}
          <TermSelect<Op>
            value={cond.op}
            items={OP_ITEMS}
            width="60px"
            onChange={(v): void => {
              onChange({ ...cond, op: v });
            }}
          />
          <Input
            {...INPUT_STYLE}
            w="60px"
            placeholder="±%"
            value={cond.thresholdPct}
            onChange={(e): void => {
              const v = e.target.value;
              onChange({ ...cond, thresholdPct: v });
            }}
          />
        </>
      ) : (
        <>
          <TermSelect<Op>
            value={cond.op}
            items={OP_ITEMS}
            width="60px"
            onChange={(v): void => {
              onChange({ ...cond, op: v });
            }}
          />
          <Input
            {...INPUT_STYLE}
            w="80px"
            placeholder="price"
            value={cond.thresholdPrice}
            onChange={(e): void => {
              const v = e.target.value;
              onChange({ ...cond, thresholdPrice: v });
            }}
          />
        </>
      )}
      <Box ml="auto">
        <MonoButton
          icon="delete"
          label="remove condition"
          disabled={!canRemove}
          onClick={onRemove}
        />
      </Box>
    </Flex>
  );
}

interface SubmitRowProps extends RowProps {
  readonly busy: boolean;
  readonly canSubmit: boolean;
  readonly onSubmit: () => void;
}

function SubmitRow({
  state,
  setState,
  busy,
  canSubmit,
  onSubmit,
}: SubmitRowProps): React.ReactElement {
  return (
    <Flex gap="6px" mt="6px" align="center">
      <Text color="term.ink3" fontSize="11px">
        interval
      </Text>
      <Input
        {...INPUT_STYLE}
        w="60px"
        value={state.intervalMin}
        onChange={(e): void => {
          const v = e.target.value;
          setState((s) => ({ ...s, intervalMin: v }));
        }}
      />
      <Text color="term.ink3" fontSize="11px">
        m
      </Text>
      <Text color="term.ink3" fontSize="11px">
        push≥
      </Text>
      <Input
        {...INPUT_STYLE}
        w="60px"
        value={state.pushIntervalMin}
        onChange={(e): void => {
          const v = e.target.value;
          setState((s) => ({ ...s, pushIntervalMin: v }));
        }}
      />
      <Text color="term.ink3" fontSize="11px">
        m
      </Text>
      <MonoButton
        icon="add"
        label={busy ? '…' : `add ${String(state.picked.length)}`}
        disabled={busy || !canSubmit}
        onClick={onSubmit}
        ml="auto"
      >
        {busy ? '…' : `add ${String(state.picked.length)}`}
      </MonoButton>
    </Flex>
  );
}
