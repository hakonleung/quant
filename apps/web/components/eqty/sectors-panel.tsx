'use client';

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { useMemo, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import {
  useAnalyzeMany,
  useKlineBulk,
  useMarketSentiment,
} from '../../lib/hooks/use-eqty-data.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useBlacklistStore } from '../../lib/stores/blacklist.store.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { Pane } from '../shell/pane.js';
import { NewSectorDialog } from './new-sector-dialog.js';

/**
 * Cap on members per analyze_many call. Each member fans out into a
 * web-search + LLM aggregator pass; >50 routinely runs into provider
 * rate-limits and burns minutes of paid LLM time. Surfaces in the
 * sector-row analyze button and 104 sector.sentiment FETCH.
 */
export const ANALYZE_MAX_CODES = 50;

export function SectorsPanel(): React.ReactElement {
  const sectors = useSectorsStore((s) => s.sectors);
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const setActiveSector = useUiStore((s) => s.setActiveSector);
  const blacklist = useBlacklistStore((s) => s.entries);
  const universe = useStockList();
  const [dialogOpen, setDialogOpen] = useState(false);

  const userRows = sectors.filter((r) => r.kind === 'user');
  const dynRows = sectors.filter((r) => r.kind === 'dynamic');

  // Synthetic "All" sector — total universe, always pinned at the top.
  const allCodes = (universe.data ?? []).map((s) => s.code);
  const allSector: Sector = {
    id: ALL_SECTOR_ID,
    name: 'All',
    kind: 'user',
    count: allCodes.length,
    meta: 'every stock',
    chgPct: null,
    codes: allCodes,
  };

  // Bulk last-2-bar fetch — the panel renders every sector's avg
  // chg%, and the union always includes the synthetic "All" basket
  // which already covers the full universe. So we always ask for the
  // universe (`codes=[]`) instead of enumerating thousands of
  // 6-digit ids in the query string. The server applies its own cap.
  // `enabled: true` forces the request because the hook would
  // otherwise gate out the empty-codes case.
  const klineBatch = useKlineBulk([], 2, { enabled: true });
  const chgPctByCode = useMemo(() => {
    const out = new Map<string, number>();
    for (const [code, bars] of klineBatch.byCode) {
      if (bars.length < 2) continue;
      const cur = bars[bars.length - 1]!;
      const prev = bars[bars.length - 2]!;
      if (prev.close === 0) continue;
      out.set(code, cur.close / prev.close - 1);
    }
    return out;
  }, [klineBatch.byCode]);

  return (
    <Pane
      feat={Feat.Sectors}
      right={
        <Text
          cursor="pointer"
          _hover={{ color: 'accent' }}
          onClick={(): void => {
            setDialogOpen(true);
          }}
        >
          + NEW
        </Text>
      }
    >
      <Flex direction="column" h="100%">
        <SideHead />
        <Box flex="1" overflow="auto">
          <SectorRow
            sector={allSector}
            selected={activeSectorId === ALL_SECTOR_ID}
            chgPctByCode={chgPctByCode}
            onClick={(): void => {
              setActiveSector(ALL_SECTOR_ID);
            }}
          />
          <SubHead label="// USER" border />
          {userRows.length === 0 ? (
            <Empty>no user sectors yet</Empty>
          ) : (
            userRows.map((r) => (
              <SectorRow
                key={r.id}
                sector={r}
                selected={activeSectorId === r.id}
                chgPctByCode={chgPctByCode}
                onClick={(): void => {
                  setActiveSector(r.id);
                }}
              />
            ))
          )}
          <SubHead label="// DYNAMIC" border />
          {dynRows.length === 0 ? (
            <Empty>no dynamic sectors yet</Empty>
          ) : (
            dynRows.map((r) => (
              <SectorRow
                key={r.id}
                sector={r}
                selected={activeSectorId === r.id}
                chgPctByCode={chgPctByCode}
                onClick={(): void => {
                  setActiveSector(r.id);
                }}
              />
            ))
          )}
        </Box>
        <Box flex="0 0 auto">
          <Pane
            feat={Feat.Blacklist}
            right={<Text>{blacklist.length}</Text>}
          >
            <Box overflow="auto" maxH="160px">
              {blacklist.length === 0 ? (
                <Empty>no blacklisted stocks</Empty>
              ) : (
                blacklist.map((b) => (
                  <Flex
                    key={b.code}
                    align="center"
                    gap="8px"
                    px="10px"
                    py="6px"
                    borderBottomWidth="1px"
                    borderColor="line2"
                    fontSize="11px"
                    _hover={{ bg: 'hover' }}
                  >
                    <Box>
                      <Text fontFamily="mono" fontSize="11px" color="ink" fontWeight="500" letterSpacing="0.04em">
                        {b.code} {b.name}
                      </Text>
                      <Text fontFamily="mono" fontSize="9px" color="ink3" letterSpacing="0.14em" mt="1px">
                        added {b.addedAt}
                      </Text>
                    </Box>
                  </Flex>
                ))
              )}
            </Box>
          </Pane>
        </Box>
      </Flex>
      <NewSectorDialog
        open={dialogOpen}
        onClose={(): void => {
          setDialogOpen(false);
        }}
      />
    </Pane>
  );
}

function SideHead(): React.ReactElement {
  return (
    <Flex
      align="center"
      gap="6px"
      px="10px"
      py="8px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
      fontFamily="mono"
      fontSize="11px"
      color="ink2"
      flexShrink={0}
    >
      <Text color="prompt" fontWeight="700">
        $
      </Text>
      <Text>sectors --list</Text>
      <Text className="blink" color="prompt">
        ▌
      </Text>
    </Flex>
  );
}

function SubHead({ label, border = false }: { label: string; border?: boolean }): React.ReactElement {
  return (
    <Text
      px="10px"
      py="6px"
      fontFamily="mono"
      fontSize="9px"
      letterSpacing="0.18em"
      color="ink3"
      fontWeight="700"
      bg="panel3"
      borderTopWidth={border ? '1px' : 0}
      borderColor="line"
    >
      {label}
    </Text>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text px="10px" py="10px" fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.12em">
      // {children}
    </Text>
  );
}

interface RowProps {
  readonly sector: Sector;
  readonly selected: boolean;
  readonly chgPctByCode: ReadonlyMap<string, number>;
  readonly onClick: () => void;
}

function SectorRow({
  sector,
  selected,
  chgPctByCode,
  onClick,
}: RowProps): React.ReactElement {
  const codes = sector.codes;
  const cached = useMarketSentiment(codes);
  const analyze = useAnalyzeMany(codes);
  const themeCount = cached.data?.themeClusters.length ?? 0;

  // Average chg% across members that have a fresh latest+previous bar.
  // Members without recent kline are excluded from both numerator and
  // denominator so a half-loaded universe doesn't drag the mean to 0.
  const avgChgPct = (() => {
    let sum = 0;
    let count = 0;
    for (const c of codes) {
      const v = chgPctByCode.get(c);
      if (v === undefined) continue;
      sum += v;
      count += 1;
    }
    return count === 0 ? null : sum / count;
  })();

  // Hard cap: analyze_many burns one paid LLM call per cluster + a
  // batched search per code, so >50 members would routinely exceed the
  // provider rate-limit. The button stays visible but un-clickable so
  // the user sees the gate instead of the action silently no-op'ing.
  const tooLarge = codes.length > ANALYZE_MAX_CODES;

  const onAnalyze = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (codes.length === 0 || analyze.isPending || tooLarge) return;
    analyze.mutate();
  };

  return (
    <Flex
      align="center"
      gap="8px"
      px={selected ? '8px' : '10px'}
      py="6px"
      borderBottomWidth="1px"
      borderColor="line2"
      borderLeftWidth={selected ? '2px' : 0}
      borderLeftColor="accent"
      bg={selected ? 'accentBg' : 'transparent'}
      cursor="pointer"
      _hover={selected ? {} : { bg: 'hover' }}
      fontSize="11px"
      onClick={onClick}
    >
      <Box flex="1" minW={0}>
        <Text fontFamily="mono" fontSize="11px" color="ink" fontWeight="500" letterSpacing="0.04em" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {sector.name}
        </Text>
        <Text fontFamily="mono" fontSize="9px" color="ink3" letterSpacing="0.14em" mt="1px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {sector.meta || `${String(sector.count)} members`}
          {themeCount > 0 ? ` · themed:${String(themeCount)}` : ''}
        </Text>
      </Box>
      {avgChgPct !== null && (
        <Text fontFamily="mono" color={avgChgPct >= 0 ? 'up' : 'down'} fontWeight="600">
          {avgChgPct >= 0 ? '+' : ''}
          {(avgChgPct * 100).toFixed(2)}%
        </Text>
      )}
      <AnalyzeBtn
        onClick={onAnalyze}
        loading={analyze.isPending}
        empty={codes.length === 0}
        themed={themeCount > 0}
        tooLarge={tooLarge}
        memberCount={codes.length}
      />
    </Flex>
  );
}

interface AnalyzeBtnProps {
  readonly onClick: (e: React.MouseEvent) => void;
  readonly loading: boolean;
  readonly empty: boolean;
  readonly themed: boolean;
  readonly tooLarge: boolean;
  readonly memberCount: number;
}

function AnalyzeBtn({
  onClick,
  loading,
  empty,
  themed,
  tooLarge,
  memberCount,
}: AnalyzeBtnProps): React.ReactElement {
  const disabled = empty || tooLarge;
  const title = empty
    ? 'no members'
    : tooLarge
      ? `too many members (${String(memberCount)} > ${String(ANALYZE_MAX_CODES)}); narrow the sector first`
      : 'analyze members';
  return (
    <Button
      ml="2px"
      h="20px"
      px="6px"
      bg={themed ? 'accentBg' : 'panel'}
      color={themed ? 'accent' : 'ink3'}
      borderWidth="1px"
      borderColor={themed ? 'accent' : 'line'}
      fontFamily="mono"
      fontSize="9px"
      letterSpacing="0.12em"
      fontWeight="700"
      borderRadius="0"
      onClick={onClick}
      loading={loading}
      disabled={disabled}
      _hover={disabled ? {} : { borderColor: 'accent', color: 'accent' }}
      title={title}
    >
      ⌘
    </Button>
  );
}


