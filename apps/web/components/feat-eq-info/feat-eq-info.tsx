'use client';

/**
 * EQ.INFO — fundamentals card for the focused stock.
 *
 * Previously lived inline at the bottom of EQ.CHART; split out into
 * its own floating tile as part of the 2026-05 island layout so users
 * can minimize/fullscreen the chart and fundamentals independently.
 *
 * Reads `useUiStore.focusCode` directly so the card stays in sync with
 * whatever EQ.CHART is showing without prop drilling through the
 * module layout.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { StockMetaDto } from '@quant/shared';
import { useMemo } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useStockMetaQuery, useStockSnapshots } from '../../lib/hooks/use-eqty-data.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { FeatSectionLabel } from '../feat-view/feat-section.js';
import { FeatView } from '../feat-view/feat-view.js';

export function FeatEqInfo(): React.ReactElement {
  const code = useUiStore((s) => s.focusCode);
  const meta = useStockMetaQuery(code ?? '');
  // Status mirrors the upstream meta fetch — green once we have the
  // fundamentals payload, amber while it's in-flight, idle when no
  // code is focused (so the pane shows but quietly stays out of the
  // way until the user picks a stock from EQ.LIST).
  const tone = code === null ? 'idle' : meta.isLoading ? 'amber' : 'green';
  return (
    <FeatView feat={Feat.EquityInfo} status={tone} statusBlink={meta.isLoading}>
      {code === null ? (
        <EmptyHint />
      ) : (
        <FundamentalsBody code={code} meta={meta.data ?? null} />
      )}
    </FeatView>
  );
}

function EmptyHint(): React.ReactElement {
  return (
    <Text px="14px" py="14px" fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.12em">
      // pick a stock from EQ.LIST
    </Text>
  );
}

interface BodyProps {
  readonly code: string;
  readonly meta: StockMetaDto | null;
}

function FundamentalsBody({ code, meta }: BodyProps): React.ReactElement {
  const codes = useMemo(() => [code], [code]);
  const snapshots = useStockSnapshots(codes);
  const snap = snapshots.byCode.get(code) ?? null;
  const derived = snap?.derived ?? null;
  const latestQ =
    meta !== null && meta.quarterlies.length > 0
      ? meta.quarterlies[meta.quarterlies.length - 1]!
      : null;
  return (
    <Box px="14px" py="10px" fontFamily="mono" fontSize="xs" color="ink2">
      <FeatSectionLabel>FUNDAMENTALS</FeatSectionLabel>
      <Box h="6px" />
      <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(120px, 1fr))" gap="4px 16px">
        <FinCell label="MKT CAP" value={fmtCny(derived?.mkt_cap ?? null)} />
        <FinCell label="FLOAT MC" value={fmtCny(derived?.float_mkt_cap ?? null)} />
        <FinCell label="PE TTM" value={fmtNum(derived?.pe_ttm ?? null)} />
        <FinCell label="PE DYN" value={fmtNum(derived?.pe_dynamic ?? null)} />
        <FinCell label="PB" value={fmtNum(derived?.pb ?? null)} />
        <FinCell label="PEG" value={fmtNum(derived?.peg ?? null)} />
        <FinCell label="GM TTM" value={fmtPct(derived?.gross_margin_ttm ?? null)} />
        <FinCell label="NET ASSETS" value={fmtCny(meta?.net_assets ?? null)} />
        <FinCell label="TOTAL SHARE" value={fmtShare(meta?.total_share ?? null)} />
        <FinCell label="FLOAT SHARE" value={fmtShare(meta?.float_share ?? null)} />
      </Box>
      <Box mt="8px" pt="6px" borderTopWidth="1px" borderColor="glass.line">
        <Text color="ink3" fontSize="xs" letterSpacing="0.16em" mb="4px">
          LATEST QUARTER {latestQ?.period ?? '—'}
        </Text>
        <Box
          display="grid"
          gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))"
          gap="4px 16px"
        >
          <FinCell label="REVENUE" value={fmtCny(latestQ?.revenue ?? null)} />
          <FinCell label="OP COST" value={fmtCny(latestQ?.operating_cost ?? null)} />
          <FinCell label="NET PROFIT" value={fmtCny(latestQ?.net_profit ?? null)} />
          <FinCell label="NET PROFIT EXNR" value={fmtCny(latestQ?.net_profit_excl_nr ?? null)} />
        </Box>
      </Box>
    </Box>
  );
}

function FinCell({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Flex gap="6px" align="baseline">
      <Text color="ink3" letterSpacing="0.10em" fontSize="xs" minW="64px">
        {label}
      </Text>
      <Text color={value === '—' ? 'ink3' : 'ink'} fontWeight="600">
        {value}
      </Text>
    </Flex>
  );
}

function fmtCny(raw: string | null): string {
  if (raw === null) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  const yi = n / 1e8;
  if (Math.abs(yi) >= 1) return `${yi.toFixed(2)}亿`;
  const wan = n / 1e4;
  if (Math.abs(wan) >= 1) return `${wan.toFixed(2)}万`;
  return n.toFixed(2);
}

function fmtNum(raw: string | null): string {
  if (raw === null) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

function fmtPct(raw: string | null): string {
  if (raw === null) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

function fmtShare(raw: string | null): string {
  if (raw === null) return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  const yi = n / 1e8;
  if (Math.abs(yi) >= 1) return `${yi.toFixed(2)}亿股`;
  const wan = n / 1e4;
  if (Math.abs(wan) >= 1) return `${wan.toFixed(2)}万股`;
  return `${n.toFixed(0)}股`;
}
