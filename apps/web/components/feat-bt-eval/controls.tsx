'use client';

/**
 * Controls row for the BT.EVAL pane: date inputs, holdings field, RUN
 * + CANCEL buttons, and the cache-status chip. Extracted from
 * `feat-bt-eval.tsx` to keep that file under the 400-line limit; the
 * pane was hitting the cap once the cached-read wiring landed.
 */

import { Box, Button, Flex, Input, Text } from '@chakra-ui/react';

export interface ControlsProps {
  readonly startDate: string;
  readonly endDate: string;
  readonly holdingsText: string;
  readonly onStart: (v: string) => void;
  readonly onEnd: (v: string) => void;
  readonly onHoldings: (v: string) => void;
  readonly onRun: () => void;
  readonly onCancel: (() => void) | null;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly cacheState: string;
}

export function Controls(p: ControlsProps): React.ReactElement {
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
      <ActionButtons
        onRun={p.onRun}
        onCancel={p.onCancel}
        disabled={p.disabled}
        pending={p.pending}
      />
      <CacheChip label={p.cacheState} />
    </Flex>
  );
}

function ActionButtons(
  p: Pick<ControlsProps, 'onRun' | 'onCancel' | 'disabled' | 'pending'>,
): React.ReactElement {
  return (
    <>
      <Button
        h="22px"
        px="10px"
        bg="accent"
        color="panel"
        borderRadius="0"
        fontFamily="mono"
        fontSize="xs"
        letterSpacing="0.14em"
        fontWeight="700"
        loading={p.pending}
        disabled={p.disabled}
        onClick={p.onRun}
      >
        RUN
      </Button>
      {p.onCancel !== null && (
        <Button
          h="22px"
          px="10px"
          bg="panel"
          color="ink2"
          borderWidth="1px"
          borderColor="line"
          borderRadius="0"
          fontFamily="mono"
          fontSize="xs"
          letterSpacing="0.14em"
          onClick={p.onCancel}
        >
          CANCEL
        </Button>
      )}
    </>
  );
}

function CacheChip({ label }: { readonly label: string }): React.ReactElement {
  return (
    <Text
      fontFamily="mono"
      fontSize="xs"
      color={label === 'cache' ? 'accent' : 'ink3'}
      letterSpacing="0.12em"
    >
      // {label}
    </Text>
  );
}

interface FieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly width: string;
  readonly placeholder?: string;
}

function Field({ label, value, onChange, width, placeholder }: FieldProps): React.ReactElement {
  return (
    <Flex gap="4px" align="center">
      <Box fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.06em">
        {label}
      </Box>
      <Input
        h="22px"
        w={width}
        bg="panel"
        borderWidth="1px"
        borderColor="line"
        borderRadius="0"
        fontFamily="mono"
        fontSize="xs"
        color="ink1"
        px="6px"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </Flex>
  );
}
