'use client';

/**
 * Right-side dashboard for TERM.MAIN — replicates the FOCUS pane in the
 * CRT reference (docs/CRT Terminal - standalone.html). Driven by the
 * preview code passed in by `feat-term-main`:
 *
 *   - while the active terminal widget is a stock list, the highlighted
 *     row's code is forwarded as the preview code (so the panel follows
 *     keyboard navigation)
 *   - otherwise, the global focus code is used
 *
 * Layout:
 *   ► FOCUS  <code> <name>      ← header
 *   industry / sector
 *   user-applied SYS.CFG columns (price, chg, mktCap, peTtm, …)
 *   sentiment (cached): score / theme / driver
 *   90D mini kline + volume
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { Sentiment, StockSnapshotDto } from '@quant/shared';

import { COLUMN_CATALOG, type ColumnKey } from '../../lib/eqty/columns.catalog.js';
import {
  useKline,
  useSentiment,
  useStockMetaQuery,
  useStockSnapshots,
} from '../../lib/hooks/use-eqty-data.js';
import { useSettingsStore } from '../../lib/stores/settings.store.js';

import { MiniKline } from './mini-kline.js';

interface Props {
  readonly code: string | null;
}

export function StockDashboard({ code }: Props): React.ReactElement {
  if (code === null) {
    return (
      <Frame>
        <Text color="term.ink3" fontSize="11px">
          ▸ FOCUS — none
        </Text>
        <Text color="term.ink3" fontSize="10px" mt="6px">
          run `focus &lt;code&gt;` or pick a stock
        </Text>
      </Frame>
    );
  }
  return <FocusPanel code={code} />;
}

function FocusPanel({ code }: { code: string }): React.ReactElement {
  const meta = useStockMetaQuery(code).data ?? null;
  const snaps = useStockSnapshots([code]);
  const snap = snaps.byCode.get(code) ?? null;
  const sent = useSentiment(code).data ?? null;
  const klineQ = useKline(code, '90D');
  const bars = klineQ.data ?? [];

  const applied = useSettingsStore((s) => s.appliedColumns);

  return (
    <Frame>
      <Flex align="center" gap="6px">
        <Text color="term.amber">▸</Text>
        <Text color="term.ink3" fontSize="10px" letterSpacing="0.18em">
          FOCUS
        </Text>
      </Flex>
      <Text color="term.ink" fontSize="22px" fontFamily="mono" fontWeight="700" mt="4px">
        {code}
      </Text>
      <Text color="term.ink2" fontSize="11px" mt="2px">
        {meta?.name ?? '—'}
        <Text as="span" color="term.ink3" ml="6px">
          · {meta?.industries ?? '—'}
        </Text>
      </Text>

      <Box mt="14px" />
      <KvRow k="price" v={fmtNum(snap?.price ?? null)} />
      {applied.map((key) => (
        <KvRow key={key} k={labelOf(key)} v={fmtAppliedField(key, snap, code)} />
      ))}

      <Box mt="14px" pt="10px" borderTopWidth="1px" borderTopColor="term.line">
        <Flex align="center" gap="6px">
          <Text color="term.amber">◆</Text>
          <Text color="term.ink3" fontSize="10px" letterSpacing="0.18em">
            SENTIMENT
          </Text>
        </Flex>
        {sent === null ? (
          <Text color="term.ink3" fontSize="10px" mt="4px">
            no cached analysis — `analyze {code}` (paid)
          </Text>
        ) : (
          <SentimentBlock s={sent} />
        )}
      </Box>

      <Box mt="14px" pt="10px" borderTopWidth="1px" borderTopColor="term.line">
        <Flex align="center" gap="6px">
          <Text color="term.amber">◆</Text>
          <Text color="term.ink3" fontSize="10px" letterSpacing="0.18em">
            {code} 90D
          </Text>
        </Flex>
        <Box mt="6px">
          <MiniKline bars={bars} cols={48} />
        </Box>
      </Box>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box
      w="100%"
      h="100%"
      px="12px"
      py="12px"
      bg="rgba(10,14,16,0.72)"
      borderLeftWidth="1px"
      borderLeftColor="term.line"
      fontFamily="mono"
      color="term.ink2"
      overflow="auto"
      position="relative"
      zIndex={1}
    >
      {children}
    </Box>
  );
}

function KvRow({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <Flex justify="space-between" align="baseline" fontSize="11px" mt="3px">
      <Text color="term.ink3">{k}</Text>
      <Text color="term.ink" fontWeight="600">
        {v}
      </Text>
    </Flex>
  );
}

function SentimentBlock({ s }: { s: Sentiment }): React.ReactElement {
  const scoreColor =
    s.score >= 0.5 ? 'term.green' : s.score <= -0.5 ? 'term.red' : 'term.amber';
  return (
    <Box mt="6px" fontSize="11px">
      <Flex justify="space-between">
        <Text color="term.ink3">score</Text>
        <Text color={scoreColor} fontWeight="700">
          {s.score.toFixed(2)}
        </Text>
      </Flex>
      <Flex justify="space-between" mt="2px">
        <Text color="term.ink3">theme</Text>
        <Text color="term.ink" maxW="60%" textAlign="right" wordBreak="break-word">
          {s.theme || '—'}
        </Text>
      </Flex>
      <Flex justify="space-between" mt="2px">
        <Text color="term.ink3">driver</Text>
        <Text color="term.ink" maxW="60%" textAlign="right" wordBreak="break-word">
          {s.driver || '—'}
        </Text>
      </Flex>
    </Box>
  );
}

function labelOf(key: ColumnKey): string {
  const spec = COLUMN_CATALOG.find((c) => c.key === key);
  return spec?.label ?? key;
}

function fmtNum(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
  return n.toFixed(2);
}

function fmtAppliedField(
  key: ColumnKey,
  snap: StockSnapshotDto | null,
  _code: string,
): string {
  if (snap === null) return '—';
  const d = snap.derived;
  switch (key) {
    case 'name':
      return snap.meta.name;
    case 'price':
      return fmtNum(snap.price);
    case 'chgPct':
      // Not in snapshot DTO; we'd need a kline-derived value. Show — for now.
      return '—';
    case 'turnoverRate':
    case 'turnover':
    case 'consecUp':
      return '—';
    case 'mktCap':
      return fmtNum(d.mkt_cap);
    case 'floatMktCap':
      return fmtNum(d.float_mkt_cap);
    case 'peTtm':
      return fmtNum(d.pe_ttm);
    case 'peDynamic':
      return fmtNum(d.pe_dynamic);
    case 'pb':
      return fmtNum(d.pb);
    case 'peg':
      return fmtNum(d.peg);
    case 'grossMargin': {
      const n = d.gross_margin_ttm === null ? null : Number(d.gross_margin_ttm);
      if (n === null || !Number.isFinite(n)) return '—';
      return `${(n * 100).toFixed(2)}%`;
    }
    default:
      return '—';
  }
}
