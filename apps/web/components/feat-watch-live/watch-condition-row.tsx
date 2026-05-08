'use client';

/**
 * Condition list + per-condition row for the WATCH add-form. Split
 * out of `watch-add-form.tsx` to keep the orchestrator under the
 * 400-line ceiling and so the condition encoding (read-only badge vs
 * editable form fields, pct vs abs branches) is its own readable unit.
 */

import { Box, Flex, Input, Text } from '@chakra-ui/react';
import type { WatchBaseline } from '@quant/shared';

import {
  BASELINE_ITEMS,
  describeCondition,
  INITIAL_CONDITION,
  KIND_ITEMS,
  OP_ITEMS,
  type ConditionDraft,
  type Kind,
  type Op,
} from '../../lib/fp/watch-add-fp.js';
import { MonoButton } from '../ui/mono-button.js';

import { TermSelect } from './term-select.js';
import type { RowProps } from './watch-add-rows.js';
import { INPUT_STYLE } from './watch-form-style.js';

interface ConditionsListProps extends RowProps {
  readonly readOnly: boolean;
}

export function ConditionsList({
  state,
  setState,
  readOnly,
}: ConditionsListProps): React.ReactElement {
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
        {readOnly ? null : (
          <MonoButton icon="add" label="add condition" onClick={onAdd}>
            add
          </MonoButton>
        )}
      </Flex>
      <Flex direction="column" gap="4px">
        {state.conditions.map((c, i) => (
          <ConditionRow
            key={`cond-${String(i)}`}
            cond={c}
            canRemove={!readOnly && state.conditions.length > 1}
            readOnly={readOnly}
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
  readonly readOnly: boolean;
  readonly onChange: (next: ConditionDraft) => void;
  readonly onRemove: () => void;
}

function ConditionRow({
  cond,
  canRemove,
  readOnly,
  onChange,
  onRemove,
}: ConditionRowProps): React.ReactElement {
  if (readOnly) {
    return (
      <Flex gap="6px" wrap="wrap" align="center" color="term.ink3" fontSize="11px">
        <Text fontFamily="mono">{describeCondition(cond)}</Text>
      </Flex>
    );
  }
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
        <PctConditionFields cond={cond} onChange={onChange} />
      ) : (
        <AbsConditionFields cond={cond} onChange={onChange} />
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

interface FieldsProps {
  readonly cond: ConditionDraft;
  readonly onChange: (next: ConditionDraft) => void;
}

function PctConditionFields({ cond, onChange }: FieldsProps): React.ReactElement {
  return (
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
  );
}

function AbsConditionFields({ cond, onChange }: FieldsProps): React.ReactElement {
  return (
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
  );
}
