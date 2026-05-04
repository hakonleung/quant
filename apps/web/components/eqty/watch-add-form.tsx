'use client';

/**
 * Inline add-form for the Watch pane.
 *
 * Batch flow: user picks N stocks via the M-0 search (chips); the same
 * condition list is applied to every picked stock — submitting POSTs
 * one task per stock. Conditions are an editable list (≥ 1 entry) so a
 * single task can fire on any of several thresholds.
 *
 * v0 only POSTs sequentially via the BFF — no dedicated batch endpoint.
 */

import { Box, Button, Flex, Input, Text } from '@chakra-ui/react';
import {
  WatchTaskCreateSchema,
  type WatchBaseline,
  type WatchCondition,
  type WatchMarket,
  type WatchTaskCreate,
} from '@quant/shared';
import { useState } from 'react';
import { z } from 'zod';

import type { UniverseStock } from '../../lib/hooks/use-stock-universe.js';
import { SearchPane } from './stock-command-bar.js';
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
];
const OP_ITEMS = [
  { label: '≥', value: 'gte' as const },
  { label: '≤', value: 'lte' as const },
];

const INPUT_STYLE = {
  bg: 'term.bg' as const,
  borderColor: 'term.line' as const,
  color: 'term.ink' as const,
  fontFamily: 'mono' as const,
  fontSize: '12px',
  h: '24px',
  px: '6px',
};

interface PickedStock {
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
}

interface AddFormState {
  readonly picked: readonly PickedStock[];
  readonly conditions: readonly ConditionDraft[];
  readonly intervalSec: string;
  readonly pushIntervalSec: string;
}

const INITIAL_CONDITION: ConditionDraft = {
  kind: 'pct',
  baseline: 'prev_close',
  thresholdPct: '5',
  op: 'gte',
  thresholdPrice: '100',
};

const INITIAL_STATE: AddFormState = {
  picked: [],
  conditions: [INITIAL_CONDITION],
  intervalSec: '20',
  pushIntervalSec: '300',
};

function toCondition(c: ConditionDraft): WatchCondition {
  return c.kind === 'pct'
    ? { kind: 'pct', baseline: c.baseline, thresholdPct: c.thresholdPct }
    : { kind: 'abs', op: c.op, thresholdPrice: c.thresholdPrice };
}

function buildDraft(s: AddFormState, stock: PickedStock): WatchTaskCreate {
  return WatchTaskCreateSchema.parse({
    market: stock.market,
    code: stock.code,
    name: stock.name,
    conditions: s.conditions.map(toCondition),
    intervalSec: Number(s.intervalSec),
    pushIntervalSec: Number(s.pushIntervalSec),
  });
}

interface AddFormProps {
  readonly onClose: () => void;
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

export function WatchAddForm({ onClose }: AddFormProps): React.ReactElement {
  const [state, setState] = useState<AddFormState>(INITIAL_STATE);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<readonly string[]>([]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setErrs([]);
    try {
      const failures = await postBatch(state);
      if (failures.length === 0) onClose();
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

function PickRow({ state, setState }: RowProps): React.ReactElement {
  const onPick = (s: UniverseStock): void => {
    setState((prev) => {
      if (prev.picked.some((p) => p.market === s.market && p.code === s.code)) return prev;
      const next: PickedStock = { market: s.market, code: s.code, name: s.name };
      return { ...prev, picked: [...prev.picked, next] };
    });
  };
  const onRemove = (idx: number): void => {
    setState((prev) => ({ ...prev, picked: prev.picked.filter((_, i) => i !== idx) }));
  };
  return (
    <Box>
      <SearchPane onPick={onPick} />
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
              <Box
                as="button"
                aria-label={`remove ${p.code}`}
                onClick={(): void => {
                  onRemove(i);
                }}
                color="term.ink3"
                _hover={{ color: 'term.red' }}
                px="2px"
              >
                ×
              </Box>
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
        <Button
          size="xs"
          variant="ghost"
          color="term.green"
          onClick={onAdd}
        >
          + add
        </Button>
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
            width="76px"
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
      <Button
        size="xs"
        variant="ghost"
        color="term.red"
        ml="auto"
        disabled={!canRemove}
        onClick={onRemove}
      >
        ×
      </Button>
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
        value={state.intervalSec}
        onChange={(e): void => {
          const v = e.target.value;
          setState((s) => ({ ...s, intervalSec: v }));
        }}
      />
      <Text color="term.ink3" fontSize="11px">
        push≥
      </Text>
      <Input
        {...INPUT_STYLE}
        w="60px"
        value={state.pushIntervalSec}
        onChange={(e): void => {
          const v = e.target.value;
          setState((s) => ({ ...s, pushIntervalSec: v }));
        }}
      />
      <Button
        size="xs"
        variant="outline"
        color="term.green"
        borderColor="term.green"
        ml="auto"
        disabled={busy || !canSubmit}
        onClick={onSubmit}
      >
        {busy ? '…' : `add ${String(state.picked.length)}`}
      </Button>
    </Flex>
  );
}
