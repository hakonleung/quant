'use client';

/**
 * Inline add-form for the Watch pane (`docs/modules/W-0-watch.md` §11.1
 * — `<WatchEditor/>` row, minimal v0).
 *
 * Single-condition flow only (one pct or abs); multi-condition AST
 * editor is a follow-up. POSTs to `/api/watch` and lets the parent
 * close the form on success — the SSE stream pushes the new task into
 * view on the next tick.
 */

import { Box, Button, Flex, Input, Text } from '@chakra-ui/react';
import {
  WatchBaselineSchema,
  WatchMarketSchema,
  WatchTaskCreateSchema,
  type WatchBaseline,
  type WatchCondition,
  type WatchMarket,
  type WatchTaskCreate,
} from '@quant/shared';
import { useState, type ChangeEvent } from 'react';
import { z } from 'zod';

import { LookupStatus, useStockLookup } from './use-watch-lookup.js';

const KindSchema = z.enum(['pct', 'abs']);
type Kind = z.infer<typeof KindSchema>;
const OpSchema = z.enum(['gte', 'lte']);
type Op = z.infer<typeof OpSchema>;

const SELECT_STYLE: React.CSSProperties = {
  background: 'transparent',
  color: 'inherit',
  border: '1px solid currentColor',
  padding: '2px 4px',
  fontFamily: 'monospace',
  fontSize: 12,
};
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
  readonly market: WatchMarket;
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
  market: 'a',
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
  const code = s.code.trim();
  const condition: WatchCondition =
    s.kind === 'pct'
      ? { kind: 'pct', baseline: s.baseline, thresholdPct: s.thresholdPct }
      : { kind: 'abs', op: s.op, thresholdPrice: s.thresholdPrice };
  // Defaulted fields (remaining / notifySlack / enabled) are filled
  // by the zod schema; we only ship the required surface here.
  return WatchTaskCreateSchema.parse({
    market: s.market,
    code,
    name: s.name.trim() || code,
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

/**
 * Auto-fill the name from the resolved stock when the user left it blank.
 * Keeps the form's submit closure short.
 */
function applyResolvedName(
  state: AddFormState,
  lookup: ReturnType<typeof useStockLookup>,
): AddFormState {
  if (lookup.kind !== 'found' || state.name.trim() !== '') return state;
  return { ...state, name: lookup.stock.name };
}

export function WatchAddForm({ onClose }: AddFormProps): React.ReactElement {
  const [state, setState] = useState<AddFormState>(INITIAL_STATE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lookup = useStockLookup(state.market, state.code);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const failure = await postDraft(applyResolvedName(state, lookup));
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
      <LookupStatus lookup={lookup} />
      <ConditionRow state={state} setState={setState} />
      <SubmitRow
        state={state}
        setState={setState}
        busy={busy}
        canSubmit={lookup.kind === 'found'}
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
    <Flex gap="6px" wrap="wrap" align="center">
      <select
        value={state.market}
        onChange={(e: ChangeEvent<HTMLSelectElement>): void => {
          const v = WatchMarketSchema.parse(e.target.value);
          setState((s) => ({ ...s, market: v }));
        }}
        style={SELECT_STYLE}
      >
        <option value="a">a</option>
        <option value="hk">hk</option>
        <option value="us">us</option>
      </select>
      <Input
        {...INPUT_STYLE}
        w="100px"
        placeholder="code"
        value={state.code}
        onChange={(e): void => {
          const v = e.target.value;
          setState((s) => ({ ...s, code: v }));
        }}
      />
      <Input
        {...INPUT_STYLE}
        w="120px"
        placeholder="name (opt)"
        value={state.name}
        onChange={(e): void => {
          const v = e.target.value;
          setState((s) => ({ ...s, name: v }));
        }}
      />
    </Flex>
  );
}

function ConditionRow({ state, setState }: RowProps): React.ReactElement {
  return (
    <Flex gap="6px" wrap="wrap" align="center" mt="6px">
      <select
        value={state.kind}
        onChange={(e): void => {
          const v = KindSchema.parse(e.target.value);
          setState((s) => ({ ...s, kind: v }));
        }}
        style={SELECT_STYLE}
      >
        <option value="pct">pct</option>
        <option value="abs">abs</option>
      </select>
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
      <select
        value={state.baseline}
        onChange={(e): void => {
          const v = WatchBaselineSchema.parse(e.target.value);
          setState((s) => ({ ...s, baseline: v }));
        }}
        style={SELECT_STYLE}
      >
        <option value="prev_close">prev_close</option>
        <option value="day_high">day_high</option>
        <option value="day_low">day_low</option>
      </select>
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
      <select
        value={state.op}
        onChange={(e): void => {
          const v = OpSchema.parse(e.target.value);
          setState((s) => ({ ...s, op: v }));
        }}
        style={SELECT_STYLE}
      >
        <option value="gte">≥</option>
        <option value="lte">≤</option>
      </select>
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
