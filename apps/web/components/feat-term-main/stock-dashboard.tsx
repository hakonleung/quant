'use client';

/**
 * Right-side dashboard for TERM.MAIN. Layout (top → bottom):
 *
 *   1. 90D mini K-line chart (always at top)
 *   2. ▸ FOCUS  <code>  <name>  ·  <industry>
 *   3. Two-column metric grid (code/name/industry + every SYS.CFG-applied
 *      column from the EQ.LIST catalog)
 *   4. Sentiment block — only rendered when a cached analysis exists.
 *      Shows score (with bar) / theme / driver / result (=摘要).
 *
 * Driven by a single `code` prop. The caller decides whether that's the
 * widget-preview code or the global focus code.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { KlineBar, Sentiment } from '@quant/shared';

import { COLUMN_CATALOG, COLUMN_KEYS, type ColumnKey } from '../../lib/eqty/columns.catalog.js';
import { listRowFromStockListRow, type ListRow } from '../../lib/fp/eq-list-fp.js';
import {
  useKline,
  useSentiment,
  useStockMetaQuery,
} from '../../lib/hooks/use-eqty-data.js';
import { useStockListRows } from '../../lib/hooks/use-stock-list-rows.js';

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
  const listQ = useStockListRows({ kind: 'user-sector', codes: [code] });
  const rawRow = listQ.data?.rows[0] ?? null;
  const row: ListRow | null = rawRow === null ? null : listRowFromStockListRow(rawRow, undefined);
  const sent = useSentiment(code).data ?? null;
  const klineQ = useKline(code, '90D');
  const bars = klineQ.data ?? [];

  return (
    <Frame>
      {/* K-LINE — top */}
      <Flex align="center" gap="6px" mb="4px">
        <Text color="term.amber">◆</Text>
        <Text color="term.ink3" fontSize="10px" letterSpacing="0.18em">
          {code} 90D
        </Text>
      </Flex>
      <Box mb="14px">
        <MiniKline bars={bars} cols={36} />
      </Box>

      {/* HEADER — code/name on the left, price/chg% on the right */}
      <Flex align="center" gap="6px">
        <Text color="term.amber">▸</Text>
        <Text color="term.ink3" fontSize="10px" letterSpacing="0.18em">
          FOCUS
        </Text>
      </Flex>
      <Flex mt="4px" gap="12px" align="flex-end" justify="space-between">
        <Box minW={0}>
          <Text color="term.ink" fontSize="22px" fontFamily="mono" fontWeight="700" lineHeight="1">
            {code}
          </Text>
          <Text color="term.ink2" fontSize="11px" mt="3px">
            {meta?.name ?? '—'}
            <Text as="span" color="term.ink3" ml="6px">
              · {meta?.industries ?? '—'}
            </Text>
          </Text>
        </Box>
        <PriceLine row={row} bars={bars} />
      </Flex>

      {/* TWO-COL METRIC GRID — excludes everything already in the header */}
      <MetricGrid row={row} bars={bars} />

      {/* SENTIMENT — only if cached */}
      {sent !== null && <SentimentBlock sent={sent} />}
    </Frame>
  );
}

function PriceLine({
  row,
  bars,
}: {
  row: ListRow | null;
  bars: readonly KlineBar[];
}): React.ReactElement {
  const price = row?.price ?? null;
  const rowChg = typeof row?.chgPct === 'number' ? row.chgPct : null;
  const change = rowChg ?? computeChangePct(bars);
  // Chinese stock-market convention — 涨红跌绿: gains paint red, losses
  // paint green. The arrow direction still tracks price direction.
  const chgColor = change === null ? 'term.ink3' : change >= 0 ? 'term.red' : 'term.green';
  const chgArrow = change === null ? '·' : change >= 0 ? '▲' : '▼';
  return (
    <Flex direction="column" align="flex-end" flexShrink={0}>
      <Text color="term.ink" fontSize="20px" fontFamily="mono" fontWeight="700" lineHeight="1">
        {fmtNum(price)}
      </Text>
      <Flex align="baseline" gap="4px" color={chgColor} mt="3px">
        <Text fontSize="12px" fontWeight="700">
          {chgArrow}
        </Text>
        <Text fontSize="12px" fontWeight="700">
          {change === null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
        </Text>
      </Flex>
    </Flex>
  );
}

function computeChangePct(bars: readonly KlineBar[]): number | null {
  if (bars.length < 2) return null;
  const last = bars.at(-1)!;
  const prev = bars.at(-2)!;
  if (prev.close === 0) return null;
  return ((last.close - prev.close) / prev.close) * 100;
}

interface MetricGridProps {
  readonly row: ListRow | null;
  readonly bars: readonly KlineBar[];
}

/**
 * Two-column grid of secondary metrics. `code`, `name`, `industry`,
 * `price`, and `chgPct` are NOT included — they're already surfaced
 * prominently in the FOCUS header / PriceLine above this grid.
 */
const HEADER_DUPES = new Set<string>(['name', 'price', 'chgPct']);

function MetricGrid({ row, bars }: MetricGridProps): React.ReactElement {
  const rows: { readonly k: string; readonly v: string }[] = [{ k: 'vol', v: fmtVolume(bars) }];
  for (const key of COLUMN_KEYS) {
    if (HEADER_DUPES.has(key)) continue;
    rows.push({ k: labelOf(key), v: fmtAppliedField(key, row) });
  }

  return (
    <Box mt="14px" pt="8px" borderTopWidth="1px" borderTopColor="term.line">
      <Box display="grid" gridTemplateColumns="1fr 1fr" gap="0 16px">
        {rows.map((r) => (
          <KvRow key={r.k} k={r.k} v={r.v} />
        ))}
      </Box>
    </Box>
  );
}

function SentimentBlock({ sent }: { sent: Sentiment }): React.ReactElement {
  const topTheme = sent.hotThemes[0]?.label ?? '—';
  const topDriver = sent.coreDrivers[0]?.summary ?? '—';
  return (
    <Box mt="14px" pt="10px" borderTopWidth="1px" borderTopColor="term.line">
      <Flex align="center" gap="6px">
        <Text color="term.amber">◆</Text>
        <Text color="term.ink3" fontSize="10px" letterSpacing="0.18em">
          SENTIMENT
        </Text>
      </Flex>
      <Box mt="6px">
        <ScoreRow score={sent.score} />
        <WrapRow k="theme" v={topTheme} />
        <WrapRow k="driver" v={topDriver} />
        {sent.brief.length > 0 && (
          <Box mt="6px">
            <Text color="term.ink3" fontSize="10px" letterSpacing="0.18em" mb="3px">
              brief
            </Text>
            <Text
              color="term.ink"
              fontSize="11px"
              lineHeight="1.45"
              whiteSpace="pre-wrap"
              wordBreak="break-word"
            >
              {sent.brief}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function ScoreRow({ score }: { score: number | null }): React.ReactElement {
  if (score === null) {
    return <KvRow k="score" v="—" />;
  }
  // Score is in [0, 1] (already normalised by the gateway).
  const t = Math.max(0, Math.min(1, score));
  const fillW = `${String(Math.round(t * 100))}%`;
  const color = t >= 0.75 ? 'term.green' : t <= 0.25 ? 'term.red' : 'term.amber';
  return (
    <Flex justify="space-between" align="center" fontSize="11px" mt="3px" gap="8px">
      <Text color="term.ink3">score</Text>
      <Flex flex="1" align="center" gap="6px" justify="flex-end">
        <Text color={color} fontWeight="700">
          {score.toFixed(2)}
        </Text>
        <Box
          position="relative"
          w="58px"
          h="6px"
          bg="term.panel2"
          borderWidth="1px"
          borderColor="term.line"
        >
          <Box position="absolute" left="0" top="0" bottom="0" w={fillW} bg={color} />
        </Box>
      </Flex>
    </Flex>
  );
}

function fmtVolume(bars: readonly KlineBar[]): string {
  const last = bars.at(-1);
  if (last === undefined) return '—';
  const v = last.volume;
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
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
    <Flex justify="space-between" align="baseline" fontSize="11px" mt="3px" gap="6px" minW={0}>
      <Text color="term.ink3" whiteSpace="nowrap">
        {k}
      </Text>
      <Text
        color="term.ink"
        fontWeight="600"
        textAlign="right"
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
      >
        {v}
      </Text>
    </Flex>
  );
}

/**
 * Like {@link KvRow} but lets the value wrap across multiple lines
 * instead of truncating with ellipsis. Used for sentiment fields
 * (theme / driver) where the LLM output can be a sentence — losing the
 * tail to ellipsis is worse than wrapping.
 */
function WrapRow({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <Flex justify="space-between" align="flex-start" fontSize="11px" mt="3px" gap="6px" minW={0}>
      <Text color="term.ink3" whiteSpace="nowrap" flexShrink={0}>
        {k}
      </Text>
      <Text
        color="term.ink"
        fontWeight="600"
        textAlign="right"
        whiteSpace="pre-wrap"
        wordBreak="break-word"
        lineHeight="1.45"
      >
        {v}
      </Text>
    </Flex>
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

// Per-column display format. Mirrors `feat-eq-list/list-columns.tsx`
// so the term dashboard prints the same value the list cell would.
type Fmt = 'num' | 'pct' | 'pctFrac' | 'cny' | 'consecUp' | 'subPct';
const FMT_BY_KEY: Readonly<Record<ColumnKey, Fmt>> = {
  name: 'num',
  price: 'num',
  chgPct: 'pctFrac',
  turnoverRate: 'pctFrac',
  turnover: 'cny',
  consecUp: 'consecUp',
  ret5d: 'pctFrac',
  ret10d: 'pctFrac',
  ret20d: 'pctFrac',
  ret90d: 'pctFrac',
  ret250d: 'pctFrac',
  wcmi: 'num',
  wcmiRhythm: 'subPct',
  wcmiMaSupport: 'subPct',
  wcmiUpWave: 'subPct',
  wcmiYangDom: 'subPct',
  wcmiShadowClean: 'subPct',
  wcmiStageGain: 'subPct',
  wcmiCrashAvoid: 'subPct',
  wcmiRecentStrength: 'subPct',
  mktCap: 'cny',
  floatMktCap: 'cny',
  peTtm: 'num',
  peDynamic: 'num',
  pb: 'num',
  peg: 'num',
  grossMargin: 'pctFrac',
  ddeMainInflow3d: 'cny',
  ddeMainInflow5d: 'cny',
  ddeMainInflow10d: 'cny',
  ddeMainInflow20d: 'cny',
  ddeMainInflowRatio3d: 'pctFrac',
  ddeMainInflowRatio5d: 'pctFrac',
  ddeMainInflowRatio10d: 'pctFrac',
  ddeMainInflowRatio20d: 'pctFrac',
};

function readRowNumber(row: ListRow, key: ColumnKey): number | null {
  const v = (row as unknown as Record<string, unknown>)[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function fmtAppliedField(key: ColumnKey, row: ListRow | null): string {
  if (row === null) return '—';
  if (key === 'name') return row.name;
  if (key === 'consecUp') {
    return row.statsReady ? `${String(row.consecUpDays)}d` : '—';
  }
  const n = readRowNumber(row, key);
  if (n === null) return '—';
  switch (FMT_BY_KEY[key]) {
    case 'pctFrac':
      return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
    case 'pct':
      return `${n.toFixed(2)}%`;
    case 'cny':
      return fmtNum(n);
    case 'subPct':
      // Already scaled [0,100] cross-sectional percentile.
      return n.toFixed(0);
    case 'num':
    default:
      return fmtNum(n);
  }
}
