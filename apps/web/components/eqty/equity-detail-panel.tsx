'use client';

import { Box, Flex, Text } from '@chakra-ui/react';
import type { KlineBar, StockMetaDto } from '@quant/shared';

import { useKline, useStockMetaQuery } from '../../lib/hooks/use-eqty-data.js';
import { Pane } from '../shell/pane.js';

interface Props {
  readonly code: string;
}

/**
 * Compact header for the EQTY workbench: identity + last close + day
 * change derived from the latest kline bar. Per-bar metrics (open /
 * high / low / 成交额 / 换手率 / MAs) live on the chart panel's focus
 * label instead of being duplicated here.
 */
export function EquityDetailPanel({ code }: Props): React.ReactElement {
  const meta = useStockMetaQuery(code);
  const kline = useKline(code, '90D');

  const bars = kline.data ?? [];
  const last = bars[bars.length - 1] ?? null;
  const prev = bars.length >= 2 ? bars[bars.length - 2]! : null;

  return (
    <Pane
      id="100"
      title="Equity Detail"
      gridArea="CTOP"
      right={
        <>
          <Text>EXCH:{exchangeFromCode(code)}</Text>
          <Text>CCY:CNY</Text>
        </>
      }
    >
      <Flex align="end" gap="20px" px="14px" py="10px" bg="panel">
        <Identity code={code} meta={meta.data ?? null} />
        <LastPrice last={last} prev={prev} loading={kline.isLoading} />
      </Flex>
    </Pane>
  );
}

function Identity({ code, meta }: { code: string; meta: StockMetaDto | null }): React.ReactElement {
  return (
    <Box>
      <Text fontFamily="mono" fontSize="11px" color="ink3" letterSpacing="0.2em" fontWeight="700">
        {code} {exchangeFromCode(code)} EQUITY
      </Text>
      <Text fontSize="16px" color="ink" mt="2px" fontWeight="600">
        {meta === null ? '—' : `${meta.name} / ${meta.name_pinyin.toUpperCase()}`}
      </Text>
    </Box>
  );
}

interface LastPriceProps {
  readonly last: KlineBar | null;
  readonly prev: KlineBar | null;
  readonly loading: boolean;
}

function LastPrice({ last, prev, loading }: LastPriceProps): React.ReactElement {
  if (loading) {
    return (
      <Text fontSize="13px" color="ink3" fontFamily="mono">
        loading kline…
      </Text>
    );
  }
  if (last === null) {
    return (
      <Text fontSize="13px" color="ink3" fontFamily="mono">
        no kline
      </Text>
    );
  }
  const change = prev === null ? 0 : last.close - prev.close;
  const changePct = prev === null || prev.close === 0 ? 0 : (change / prev.close) * 100;
  const up = changePct >= 0;
  return (
    <Flex align="baseline" gap="10px">
      <Text fontSize="24px" color={up ? 'up' : 'down'} fontFamily="mono" lineHeight="1" fontWeight="700">
        {last.close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </Text>
      <Text fontSize="11px" color={up ? 'up' : 'down'} letterSpacing="0.06em" fontWeight="600" fontFamily="mono">
        {prev === null
          ? '—'
          : `${up ? '+' : ''}${change.toFixed(2)}  ${up ? '+' : ''}${changePct.toFixed(2)}%`}
      </Text>
      <Text fontSize="10px" color="ink3" fontFamily="mono" letterSpacing="0.14em">
        {last.date}
      </Text>
    </Flex>
  );
}

function exchangeFromCode(code: string): string {
  if (code.startsWith('6')) return 'SH';
  if (code.startsWith('0') || code.startsWith('3')) return 'SZ';
  if (code.startsWith('8') || code.startsWith('4')) return 'BJ';
  return '??';
}
