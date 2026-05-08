'use client';

import { Box, Flex, Text } from '@chakra-ui/react';
import type { EnrichedLedgerEntry } from '@quant/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Decimal } from 'decimal.js';
import { useRef } from 'react';

import { MonoButton } from '../ui/mono-button.js';

interface LedgerListProps {
  readonly enriched: readonly EnrichedLedgerEntry[];
  readonly onEdit: (date: string) => void;
  readonly onDelete: (date: string) => void;
  readonly busy: boolean;
}

const ROW_H = 32;

export function LedgerList({
  enriched,
  onEdit,
  onDelete,
  busy,
}: LedgerListProps): React.ReactElement {
  // Newest first in the list view; underlying enriched is asc by date.
  const rows = [...enriched].reverse();
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  if (rows.length === 0) {
    return (
      <Flex flex="1" align="center" justify="center" minH="120px">
        <Text fontSize="11px" color="ink3" fontFamily="mono">
          暂无记录
        </Text>
      </Flex>
    );
  }

  return (
    <Box flex="1" minH={0} display="flex" flexDirection="column">
      <Header />
      <Box
        ref={scrollRef}
        flex="1"
        minH={0}
        overflowY="auto"
        position="relative"
        fontFamily="mono"
        fontSize="11px"
      >
        <Box position="relative" style={{ height: `${String(virtualizer.getTotalSize())}px` }}>
          {virtualizer.getVirtualItems().map((vRow) => {
            const entry = rows[vRow.index];
            if (entry === undefined) return null;
            return (
              <Row
                key={entry.date}
                entry={entry}
                top={vRow.start}
                height={vRow.size}
                onEdit={onEdit}
                onDelete={onDelete}
                busy={busy}
              />
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

function Header(): React.ReactElement {
  return (
    <Flex
      borderBottomWidth="1px"
      borderColor="line"
      px="10px"
      py="4px"
      gap="12px"
      fontFamily="mono"
      fontSize="9px"
      letterSpacing="0.12em"
      color="ink3"
      flexShrink={0}
    >
      <HeaderCell w="84px">DATE</HeaderCell>
      <HeaderCell w="92px" align="right">
        PNL
      </HeaderCell>
      <HeaderCell w="56px" align="right">
        PCT
      </HeaderCell>
      <HeaderCell w="100px" align="right">
        CLOSING
      </HeaderCell>
      <HeaderCell w="80px" align="right">
        CASHFLOW
      </HeaderCell>
      <Box flex="1" />
      <HeaderCell w="56px" align="right">
        OPS
      </HeaderCell>
    </Flex>
  );
}

interface HeaderCellProps {
  readonly w: string;
  readonly align?: 'left' | 'right';
  readonly children: React.ReactNode;
}

function HeaderCell({ w, align = 'left', children }: HeaderCellProps): React.ReactElement {
  return (
    <Box w={w} textAlign={align} flexShrink={0}>
      {children}
    </Box>
  );
}

interface RowProps {
  readonly entry: EnrichedLedgerEntry;
  readonly top: number;
  readonly height: number;
  readonly onEdit: (date: string) => void;
  readonly onDelete: (date: string) => void;
  readonly busy: boolean;
}

function Row({ entry, top, height, onEdit, onDelete, busy }: RowProps): React.ReactElement {
  const pnlD = new Decimal(entry.pnlAmount);
  // 涨红跌绿: positive PnL → up (red), negative → down (green).
  const pnlTone = pnlD.isPositive() && !pnlD.isZero() ? 'up' : pnlD.isNegative() ? 'down' : 'ink';
  const pctTone = pnlTone;
  const cashFlow = new Decimal(entry.cashFlow);
  const cashFlowDisplay = cashFlow.isZero() ? '—' : cashFlow.toFixed(2);
  return (
    <Flex
      position="absolute"
      top="0"
      left="0"
      right="0"
      style={{ transform: `translateY(${String(top)}px)`, height: `${String(height)}px` }}
      align="center"
      px="10px"
      gap="12px"
      borderBottomWidth="1px"
      borderColor="line"
      _hover={{ bg: 'panel2' }}
    >
      <Box w="84px" flexShrink={0}>
        {entry.date}
      </Box>
      <Box w="92px" textAlign="right" color={pnlTone} flexShrink={0}>
        {pnlD.toFixed(2)}
      </Box>
      <Box w="56px" textAlign="right" color={pctTone} flexShrink={0}>
        {new Decimal(entry.derivedDailyPct).toFixed(2)}%
      </Box>
      <Flex w="100px" justify="flex-end" align="center" gap="4px" flexShrink={0}>
        <Text fontSize="11px">{new Decimal(entry.derivedClosingPosition).toFixed(2)}</Text>
        {!entry.closingProvided && (
          <Text
            fontSize="8px"
            color="ink3"
            letterSpacing="0.1em"
            border="1px dashed"
            borderColor="line"
            px="2px"
            title="链式推导值"
          >
            ~
          </Text>
        )}
      </Flex>
      <Box w="80px" textAlign="right" color="ink3" flexShrink={0}>
        {cashFlowDisplay}
      </Box>
      <Box flex="1" />
      <Flex gap="2px" flexShrink={0}>
        <MonoButton
          icon="edit"
          label={`edit ${entry.date}`}
          disabled={busy}
          onClick={(): void => {
            onEdit(entry.date);
          }}
        />
        <MonoButton
          icon="delete"
          label={`delete ${entry.date}`}
          disabled={busy}
          onClick={(): void => {
            onDelete(entry.date);
          }}
        />
      </Flex>
    </Flex>
  );
}
