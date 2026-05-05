'use client';

import { Box, Flex, Text } from '@chakra-ui/react';
import { useMemo, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';
import { useKlineBulk, useMarketSentiment } from '../../lib/hooks/use-eqty-data.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from "../feat-view/feat-view.js";
import { FeatViewAction, FeatViewHeaderRight } from "../feat-view/feat-view-header.js";
import { NewSectorDialog } from './new-sector-dialog.js';

/**
 * Cap on members per analyze_many call. Each member fans out into a
 * web-search + LLM aggregator pass; >50 routinely runs into provider
 * rate-limits and burns minutes of paid LLM time. Surfaces in the 104
 * sector.sentiment FETCH guard.
 */
export const ANALYZE_MAX_CODES = 50;

export function FeatSecList(): React.ReactElement {
  const sectors = useSectorsStore((s) => s.sectors);
  const removeSector = useSectorsStore((s) => s.remove);
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const setActiveSector = useUiStore((s) => s.setActiveSector);
  const universe = useStockList();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { guard, comp: confirmComp } = useConfirm();

  const onDelete = (sector: Sector): void => {
    guard({
      title: 'delete sector',
      message: (
        <>
          <Text fontFamily="mono" fontSize="12px" color="ink2" lineHeight="1.7">
            delete sector{' '}
            <Text as="span" color="accent">
              {sector.name}
            </Text>
            ?
          </Text>
          <Text fontFamily="mono" fontSize="11px" color="ink3" mt="8px">
            // {String(sector.codes.length)} member(s) · this can&apos;t be undone
          </Text>
        </>
      ),
      confirmLabel: 'DELETE',
    })
      .then(() => {
        removeSector(sector.id);
        // Reset highlight when the deleted sector was active.
        // setActiveSector already clears focusCode, so list-panel's
        // auto-default picks the first row of the new (All) sector.
        if (activeSectorId === sector.id) setActiveSector(ALL_SECTOR_ID);
      })
      .catch((e: unknown) => {
        if (e instanceof ConfirmCancelled) return;
        throw e;
      });
  };

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
    <FeatView
      feat={Feat.SectorList}
      right={
        <FeatViewHeaderRight>
          <FeatViewAction
            title="new sector"
            tone="accent"
            onClick={(): void => {
              setDialogOpen(true);
            }}
          >
            +
          </FeatViewAction>
        </FeatViewHeaderRight>
      }
    >
      <Flex direction="column" h="100%">
        <SideHead />
        <Box flex="1">
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
                onDelete={(): void => {
                  onDelete(r);
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
                onDelete={(): void => {
                  onDelete(r);
                }}
              />
            ))
          )}
        </Box>
      </Flex>
      <NewSectorDialog
        open={dialogOpen}
        onClose={(): void => {
          setDialogOpen(false);
        }}
      />
      {confirmComp}
    </FeatView>
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
  /** Omitted for the synthetic "All" row, which can't be deleted. */
  readonly onDelete?: () => void;
}

function SectorRow({
  sector,
  selected,
  chgPctByCode,
  onClick,
  onDelete,
}: RowProps): React.ReactElement {
  const codes = sector.codes;
  const cached = useMarketSentiment(codes);
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
      {onDelete !== undefined && (
        <Box
          as="span"
          role="button"
          aria-label={`delete sector ${sector.name}`}
          onClick={(e: React.MouseEvent): void => {
            e.stopPropagation();
            onDelete();
          }}
          color="ink3"
          cursor="pointer"
          fontFamily="mono"
          fontSize="14px"
          lineHeight="1"
          px="4px"
          _hover={{ color: 'down' }}
          title="delete sector"
        >
          ×
        </Box>
      )}
    </Flex>
  );
}
