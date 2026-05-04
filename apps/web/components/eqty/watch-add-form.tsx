'use client';

/**
 * Inline add-form for the Watch pane (`docs/modules/W-0-watch.md` §11.1
 * — `<WatchEditor/>` row, minimal v0).
 *
 * Reuses the M-0 `<StockCommandBar/>` for ticker selection: the user
 * searches across A / HK / US in-browser; picking a row fills market /
 * code / name on the draft. No server-side `/lookup` round-trip.
 *
 * Single-condition flow only (one pct or abs); multi-condition AST
 * editor is a follow-up. POSTs to `/api/watch` and lets the parent
 * close the form on success — the SSE stream pushes the new task into
 * view on the next tick.
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

interface AddFormState {
  readonly market: WatchMarket | null;
  readonly code: string;
  readonly name: string;
  readonly kind: Kind;
  readonly baseline: WatchBaseline;
  readonly thresholdPct: string;
  readonly op: Op;
  readonly thresholdPrice: string;
  readonly intervalSec: string;
  readonly pushIntervalSec: string;
}

const INITIAL_STATE: AddFormState = {
  market: null,
  code: '',
  name: '',
  kind: 'pct',
  baseline: 'prev_close',
  thresholdPct: '5',
  op: 'gte',
  thresholdPrice: '100',
  intervalSec: '20',
  pushIntervalSec: '300',
};

function buildDraft(s: AddFormState): WatchTaskCreate {
  if (s.market === null) {
    throw new Error('pick a stock first');
  }
  const condition: WatchCondition =
    s.kind === 'pct'
      ? { kind: 'pct', baseline: s.baseline, thresholdPct: s.thresholdPct }
      : { kind: 'abs', op: s.op, thresholdPrice: s.thresholdPrice };
  return WatchTaskCreateSchema.parse({
    market: s.market,
    code: s.code,
    name: s.name,
    conditions: [condition],
    intervalSec: Number(s.intervalSec),
    pushIntervalSec: Number(s.pushIntervalSec),
  });
}

interface AddFormProps {
  readonly onClose: () => void;
}

async function postDraft(state: AddFormState): Promise<string | null> {
  const draft = buildDraft(state);
  const res = await fetch('/api/watch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
  if (res.ok) return null;
  const body = await res.text();
  return `${String(res.status)} ${body.slice(0, 160)}`;
}

export function WatchAddForm({ onClose }: AddFormProps): React.ReactElement {
  const [state, setState] = useState<AddFormState>(INITIAL_STATE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const failure = await postDraft(state);
      if (failure !== null) setErr(failure);
      else onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
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
      <IdentityRow state={state} setState={setState} />
      <ConditionRow state={state} setState={setState} />
      <SubmitRow
        state={state}
        setState={setState}
        busy={busy}
        canSubmit={state.market !== null && state.code !== ''}
        onSubmit={(): void => {
          void submit();
        }}
      />
      {err !== null ? (
        <Text mt="6px" color="term.red" fontSize="11px">
          {err}
        </Text>
      ) : null}
    </Box>
  );
}

interface RowProps {
  readonly state: AddFormState;
  readonly setState: React.Dispatch<React.SetStateAction<AddFormState>>;
}

function IdentityRow({ state, setState }: RowProps): React.ReactElement {
  return (
    <Box>
      <SearchPane
        onPick={(s): void => {
          setState((prev) => ({ ...prev, market: s.market, code: s.code, name: s.name }));
        }}
      />
      {state.market !== null && state.code !== '' ? (
        <Text mt="4px" fontSize="11px" color="term.green">
          ✓ [{state.market}] {state.code} · {state.name}
        </Text>
      ) : (
        <Text mt="4px" fontSize="11px" color="term.ink3">
          pick a stock to continue
        </Text>
      )}
    </Box>
  );
}

function ConditionRow({ state, setState }: RowProps): React.ReactElement {
  return (
    <Flex gap="6px" wrap="wrap" align="center" mt="6px">
      <TermSelect<Kind>
        value={state.kind}
        items={KIND_ITEMS}
        width="76px"
        onChange={(v): void => {
          setState((s) => ({ ...s, kind: v }));
        }}
      />
      {state.kind === 'pct' ? (
        <PctFields state={state} setState={setState} />
      ) : (
        <AbsFields state={state} setState={setState} />
      )}
    </Flex>
  );
}

function PctFields({ state, setState }: RowProps): React.ReactElement {
  return (
    <>
      <TermSelect<WatchBaseline>
        value={state.baseline}
        items={BASELINE_ITEMS}
        width="130px"
        onChange={(v): void => {
          setState((s) => ({ ...s, baseline: v }));
        }}
      />
      <Input
        {...INPUT_STYLE}
        w="60px"
        placeholder="±%"
        value={state.thresholdPct}
        onChange={(e): void => {
          const v = e.target.value;
          setState((s) => ({ ...s, thresholdPct: v }));
        }}
      />
    </>
  );
}

function AbsFields({ state, setState }: RowProps): React.ReactElement {
  return (
    <>
      <TermSelect<Op>
        value={state.op}
        items={OP_ITEMS}
        width="76px"
        onChange={(v): void => {
          setState((s) => ({ ...s, op: v }));
        }}
      />
      <Input
        {...INPUT_STYLE}
        w="80px"
        placeholder="price"
        value={state.thresholdPrice}
        onChange={(e): void => {
          const v = e.target.value;
          setState((s) => ({ ...s, thresholdPrice: v }));
        }}
      />
    </>
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
        {busy ? '…' : 'add'}
      </Button>
    </Flex>
  );
}
