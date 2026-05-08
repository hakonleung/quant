'use client';

import { Box, Flex, Text } from '@chakra-ui/react';
import {
  currentPosition,
  daysSinceFirst,
  totalCashFlow,
  totalPnlAmount,
  totalReturnPct,
  type EnrichedLedgerEntry,
} from '@quant/shared';
import { Decimal } from 'decimal.js';
import { useMemo } from 'react';

interface LedgerSummaryBarProps {
  readonly enriched: readonly EnrichedLedgerEntry[];
  /** "Today" injected so the component stays pure-render — `daysSinceFirst`
   *  refuses to call `new Date()`. Falls back to UTC today on the client. */
  readonly today?: string;
}

export function LedgerSummaryBar({ enriched, today }: LedgerSummaryBarProps): React.ReactElement {
  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  const summary = useMemo(() => {
    if (enriched.length === 0) {
      return {
        empty: true as const,
      };
    }
    return {
      empty: false as const,
      pnl: totalPnlAmount(enriched),
      // Total cash flow naturally excludes the anchor — `cashFlow` on
      // the first row is always 0 by construction.
      cashFlow: totalCashFlow(enriched),
      position: currentPosition(enriched),
      returnPct: totalReturnPct(enriched),
      days: daysSinceFirst(enriched, todayStr),
    };
  }, [enriched, todayStr]);

  if (summary.empty) {
    return (
      <Flex px="10px" py="8px" borderBottomWidth="1px" borderColor="line" flexShrink={0}>
        <Text fontSize="11px" color="ink3" fontFamily="mono">
          账本为空，先添加首条记录（必须包含当日收盘仓位）。
        </Text>
      </Flex>
    );
  }

  return (
    <Flex
      px="10px"
      py="8px"
      gap="16px"
      borderBottomWidth="1px"
      borderColor="line"
      flexWrap="wrap"
      flexShrink={0}
    >
      <Stat label="总盈亏" value={fmtMoney(summary.pnl)} tone={signTone(summary.pnl)} />
      <Stat label="总入金" value={fmtMoney(summary.cashFlow)} tone={signTone(summary.cashFlow)} />
      <Stat label="当前仓位" value={fmtMoney(summary.position)} />
      <Stat
        label={`累计涨跌（${String(summary.days)}d）`}
        value={`${fmtPct(summary.returnPct)}%`}
        tone={signTone(summary.returnPct)}
      />
    </Flex>
  );
}

interface StatProps {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'pos' | 'neg' | 'flat';
  readonly muted?: boolean;
}

function Stat({ label, value, tone = 'flat', muted = false }: StatProps): React.ReactElement {
  // 涨红跌绿: positive → up (red), negative → down (green).
  const color = tone === 'pos' ? 'up' : tone === 'neg' ? 'down' : muted ? 'ink3' : 'ink';
  return (
    <Box>
      <Text fontSize="9px" letterSpacing="0.16em" color="ink3" fontFamily="mono">
        {label.toUpperCase()}
      </Text>
      <Text fontSize="13px" color={color} fontFamily="mono" fontWeight="600">
        {value}
      </Text>
    </Box>
  );
}

function signTone(value: string): 'pos' | 'neg' | 'flat' {
  const d = new Decimal(value);
  if (d.isPositive() && !d.isZero()) return 'pos';
  if (d.isNegative()) return 'neg';
  return 'flat';
}

function fmtMoney(value: string): string {
  const d = new Decimal(value);
  return d.toFixed(2);
}

function fmtPct(value: string): string {
  const d = new Decimal(value);
  return d.toFixed(2);
}
