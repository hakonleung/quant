'use client';

import { Box, Flex, Table, Text } from '@chakra-ui/react';

import type { BlotterRow, NlScreenResult, ScreenMatchView } from '@quant/shared';
import { useSectorHits } from '../../lib/hooks/use-eqty-data.js';
import { useSectorsStore } from '../../lib/stores/sectors.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { DslTree } from '../dsl/dsl-tree.js';
import { Pane } from '../shell/pane.js';

const COLS = [
  'SYMBOL',
  'NAME',
  'LAST',
  'CHG%',
  'VOL×',
  'MA20Δ',
  'RSI14',
  'MCAP',
  'SENT',
  'EVIDENCE',
] as const;

export function BlotterPanel(): React.ReactElement {
  const nlResult = useUiStore((s) => s.nlResult);
  if (nlResult !== null) {
    return <NlScreenView result={nlResult} />;
  }
  return <SectorHitsView />;
}

function NlScreenView({ result }: { result: NlScreenResult }): React.ReactElement {
  const setNlResult = useUiStore((s) => s.setNlResult);
  return (
    <Pane
      id="120"
      title={`NL Screen · "${truncate(result.nl, 60)}"`}
      gridArea="CBOT"
      right={
        <>
          <Text>{result.matches.length} hits</Text>
          <Text
            cursor="pointer"
            color="accent"
            _hover={{ color: 'accentDark' }}
            onClick={(): void => {
              setNlResult(null);
            }}
          >
            ✕ CLEAR
          </Text>
        </>
      }
    >
      <Flex h="100%" minH={0}>
        <Box w="42%" minW="280px" borderRightWidth="1px" borderColor="line" overflow="auto" px="12px" py="10px" bg="panel3">
          <DslTree screenPlan={result.screenPlan} universePlan={result.universePlan} />
        </Box>
        <Box flex="1" overflow="auto">
          <MatchTable matches={result.matches} />
        </Box>
      </Flex>
    </Pane>
  );
}

function SectorHitsView(): React.ReactElement {
  const selectedIds = useSectorsStore((s) => s.selectedIds);
  const { data, isLoading } = useSectorHits(selectedIds);
  const title = selectedIds.length === 0 ? 'Sector Hits · (none selected)' : `Sector Hits · ${String(selectedIds.length)} sector(s)`;

  return (
    <Pane id="120" title={title} gridArea="CBOT" right={<Text>{data?.length ?? 0} rows</Text>}>
      <Box overflow="auto" h="100%">
        <Table.Root size="sm" w="100%" fontSize="11px" css={{ borderCollapse: 'collapse' }}>
          <Table.Header>
            <Table.Row>
              {COLS.map((c, i) => (
                <Table.ColumnHeader
                  key={c}
                  textAlign={i <= 1 ? 'left' : 'right'}
                  px="10px"
                  py="5px"
                  bg="panel3"
                  color="ink3"
                  fontFamily="mono"
                  fontSize="10px"
                  letterSpacing="0.16em"
                  textTransform="uppercase"
                  fontWeight="700"
                  borderBottomWidth="1px"
                  borderColor="line2"
                >
                  {c}
                </Table.ColumnHeader>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {isLoading ? (
              <Table.Row>
                <Table.Cell colSpan={COLS.length} px="10px" py="14px" color="ink3" fontFamily="mono" fontSize="11px">
                  loading hits…
                </Table.Cell>
              </Table.Row>
            ) : data === undefined || data.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={COLS.length} px="10px" py="14px" color="ink3" fontFamily="mono" fontSize="11px" letterSpacing="0.12em">
                  // {selectedIds.length === 0 ? 'select sectors on the left to see hits' : 'no hits'}
                </Table.Cell>
              </Table.Row>
            ) : (
              data.map((row) => <Row key={row.code} row={row} />)
            )}
          </Table.Body>
        </Table.Root>
      </Box>
    </Pane>
  );
}

function MatchTable({ matches }: { matches: readonly ScreenMatchView[] }): React.ReactElement {
  // Surface up to 6 most-frequently-seen evidence keys as columns; the
  // rest collapse into a JSON snippet. Keeps the table dense without
  // hiding the evaluator's reasoning.
  const evidenceKeys = pickEvidenceCols(matches);
  return (
    <Table.Root size="sm" w="100%" fontSize="11px" css={{ borderCollapse: 'collapse' }}>
      <Table.Header>
        <Table.Row>
          <HeaderCell first>SYMBOL</HeaderCell>
          {evidenceKeys.map((k) => (
            <HeaderCell key={k}>{k}</HeaderCell>
          ))}
          <HeaderCell>OTHER</HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {matches.length === 0 ? (
          <Table.Row>
            <Table.Cell
              colSpan={evidenceKeys.length + 2}
              px="10px"
              py="14px"
              color="ink3"
              fontFamily="mono"
              fontSize="11px"
              letterSpacing="0.12em"
            >
              // 0 matches
            </Table.Cell>
          </Table.Row>
        ) : (
          matches.map((m) => <MatchRow key={m.code} match={m} cols={evidenceKeys} />)
        )}
      </Table.Body>
    </Table.Root>
  );
}

function MatchRow({
  match,
  cols,
}: {
  match: ScreenMatchView;
  cols: readonly string[];
}): React.ReactElement {
  const ev = match.evidence;
  const tail = Object.fromEntries(Object.entries(ev).filter(([k]) => !cols.includes(k)));
  return (
    <Table.Row _hover={{ bg: 'hover' }}>
      <Cell first>{match.code}</Cell>
      {cols.map((k) => (
        <Cell key={k} mono>
          {formatEvidence(ev[k])}
        </Cell>
      ))}
      <Cell mono color="ink3">
        {Object.keys(tail).length === 0 ? '—' : JSON.stringify(tail)}
      </Cell>
    </Table.Row>
  );
}

function HeaderCell({ children, first = false }: { children: React.ReactNode; first?: boolean }): React.ReactElement {
  return (
    <Table.ColumnHeader
      textAlign={first ? 'left' : 'right'}
      px="10px"
      py="5px"
      bg="panel3"
      color="ink3"
      fontFamily="mono"
      fontSize="10px"
      letterSpacing="0.16em"
      textTransform="uppercase"
      fontWeight="700"
      borderBottomWidth="1px"
      borderColor="line2"
    >
      {children}
    </Table.ColumnHeader>
  );
}

function pickEvidenceCols(matches: readonly ScreenMatchView[]): readonly string[] {
  const counts = new Map<string, number>();
  for (const m of matches) {
    for (const k of Object.keys(m.evidence)) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k]) => k);
}

function formatEvidence(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === 'string') return v.length > 28 ? `${v.slice(0, 26)}…` : v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function Row({ row }: { row: BlotterRow }): React.ReactElement {
  return (
    <Table.Row _hover={{ bg: 'hover' }}>
      <Cell first>{row.code}</Cell>
      <Cell first>{row.name}</Cell>
      <Cell mono>{row.last.toFixed(2)}</Cell>
      <Cell mono color={row.chgPct >= 0 ? 'up' : 'down'}>
        {row.chgPct >= 0 ? '+' : ''}
        {row.chgPct.toFixed(2)}
      </Cell>
      <Cell mono>{row.volX.toFixed(1)}</Cell>
      <Cell mono color={row.ma20Delta >= 0 ? 'up' : 'down'}>
        {row.ma20Delta >= 0 ? '+' : ''}
        {row.ma20Delta.toFixed(1)}
      </Cell>
      <Cell mono>{row.rsi14.toFixed(0)}</Cell>
      <Cell mono>{formatNum(row.mcap)}</Cell>
      <Cell mono>
        <Box as="span" display="inline-block" px="6px" py="1px" bg="accentBg" color="accent" fontWeight="700" fontFamily="mono" fontSize="10px" letterSpacing="0.12em">
          {row.sentiment.toFixed(2)}
        </Box>
      </Cell>
      <Cell first>
        {row.evidence}
        {row.evidenceTag && (
          <Box as="span" display="inline-block" ml="6px" px="6px" py="1px" bg="badgeBg" color="ink2" fontFamily="mono" fontSize="10px" letterSpacing="0.12em">
            {row.evidenceTag}
          </Box>
        )}
      </Cell>
    </Table.Row>
  );
}

interface CellProps {
  readonly children: React.ReactNode;
  readonly first?: boolean;
  readonly mono?: boolean;
  readonly color?: string;
}

function Cell({ children, first = false, mono = false, color }: CellProps): React.ReactElement {
  return (
    <Table.Cell
      px="10px"
      py="5px"
      textAlign={first ? 'left' : 'right'}
      borderBottomWidth="1px"
      borderColor="line2"
      fontFamily={first || mono ? 'mono' : undefined}
      fontWeight={first ? '600' : undefined}
      color={color}
    >
      {children}
    </Table.Cell>
  );
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(0)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  return n.toLocaleString();
}
