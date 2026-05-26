'use client';

/**
 * Thin wrapper over Chakra `Select` that matches the cyber/term color
 * palette used by the W-0 add-form. Single-value only (the `value`
 * field is a tuple internally to match Chakra v3's collection API but
 * the consumer treats it as a scalar).
 */

import { Portal, Select, createListCollection } from '@chakra-ui/react';
import React, { useMemo } from 'react';

interface TermSelectItem<V extends string> {
  readonly label: string;
  readonly value: V;
}

export interface TermSelectProps<V extends string> {
  readonly value: V;
  readonly onChange: (next: V) => void;
  readonly items: readonly TermSelectItem<V>[];
  readonly width?: string;
}

const TRIGGER_STYLE = {
  bg: 'term.bg',
  borderColor: 'term.line',
  color: 'term.ink',
  fontFamily: 'mono',
  fontSize: '12px',
  h: '24px',
  minH: '24px',
  px: '6px',
} as const;

export function TermSelect<V extends string>(props: TermSelectProps<V>): React.ReactElement {
  const { value, onChange, items, width = '120px' } = props;
  const collection = useMemo(
    () =>
      createListCollection<TermSelectItem<V>>({
        items: items.map((i) => ({ label: i.label, value: i.value })),
      }),
    [items],
  );
  return (
    <Select.Root
      collection={collection}
      value={[value]}
      size="xs"
      width={width}
      onValueChange={(d): void => {
        const next = d.value[0];
        if (next !== undefined) onChange(next as V);
      }}
    >
      <Select.HiddenSelect />
      <Select.Control>
        <Select.Trigger {...TRIGGER_STYLE}>
          <Select.ValueText />
        </Select.Trigger>
        <Select.IndicatorGroup>
          <Select.Indicator color="term.ink3" />
        </Select.IndicatorGroup>
      </Select.Control>
      <Portal>
        <Select.Positioner>
          <Select.Content
            bg="term.panel"
            borderColor="term.line"
            borderWidth="1px"
            color="term.ink"
            fontFamily="mono"
            fontSize="sm"
          >
            {items.map((item) => (
              <Select.Item key={item.value} item={item} _hover={{ bg: 'term.line' }}>
                <Select.ItemText>{item.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
}
