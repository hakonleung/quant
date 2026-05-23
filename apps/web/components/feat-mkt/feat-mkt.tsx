'use client';

/**
 * MKT — market overview pane.
 *
 * Single FeatView that stacks the sector chip slider on top of the
 * equity list. Replaces the historical pair MKT.SEC + MKT.LIST: both
 * sub-components are mounted in `bare` mode so they contribute their
 * content without their own pane chrome.
 *
 * The chip slider stays at its natural row height; the equity list
 * fills the remaining vertical space and scrolls internally — same
 * column behaviour the user had before, just under one frame.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import { useIsFetching } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useBlacklistQuery } from '../../lib/hooks/use-blacklist.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useSectorsStore } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { useFeatHotkeys } from '../../lib/ui-cmd/hooks/use-feat-hotkeys.js';
import { FeatEqList } from '../feat-eq-list/feat-eq-list.js';
import { NewSectorDialog } from '../feat-sec-list/new-sector-dialog.js';
import { FeatSecList } from '../feat-sec-list/feat-sec-list.js';
import { FeatView } from '../feat-view/feat-view.js';
import { MonoButton } from '../ui/mono-button.js';

export function FeatMkt(): React.ReactElement {
  // Surface loading / error of the upstream feeds so the MKT pane gets
  // a status dot in the header while sectors / equity rows are still
  // hydrating. The two children own the actual fetches; we only pull
  // `isLoading` out of the same react-query keys (re-using the cached
  // result, no extra request).
  const stocks = useStockList();
  const blacklist = useBlacklistQuery();
  // Surface in-flight kline / snapshot batches owned by the embedded
  // FeatEqList — without this the MKT header flips back to green the
  // moment sectors finish loading, even though the row data is still
  // streaming in. `useIsFetching` returns the count of matching queries
  // currently fetching, so any non-zero value keeps us on amber.
  const eqtyFetching =
    useIsFetching({ queryKey: ['kline.bulk'] }) + useIsFetching({ queryKey: ['stock.snapshots'] });
  const isLoading = stocks.isLoading || blacklist.isLoading || eqtyFetching > 0;
  const tone = stocks.error !== null ? 'red' : isLoading ? 'amber' : 'green';
  const [dialogOpen, setDialogOpen] = useState(false);

  // `N` keyboard equivalent of the header's "+ new sector" button.
  // Cell metadata lives in global-cells.ts under MKT scope; we bind
  // the handler here because the dialog state is component-local.
  useFeatHotkeys(Feat.Mkt, {
    'ui.sector-new-open': () => setDialogOpen(true),
  });

  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const sectors = useSectorsStore((s) => s.sectors);
  const activeSector = sectors.find((s) => s.id === activeSectorId) ?? null;
  const isAll = activeSectorId === ALL_SECTOR_ID;
  const sectorName = isAll ? 'all' : (activeSector?.name ?? '—');

  const [counts, setCounts] = useState<{ total: number; matched: number } | null>(null);
  const onCountsChange = useCallback((c: { total: number; matched: number }): void => {
    setCounts((prev) =>
      prev !== null && prev.total === c.total && prev.matched === c.matched
        ? prev
        : { total: c.total, matched: c.matched },
    );
  }, []);

  const countLabel =
    counts === null
      ? null
      : counts.matched === counts.total
        ? String(counts.total)
        : `${String(counts.matched)}/${String(counts.total)}`;

  return (
    <FeatView
      feat={Feat.Mkt}
      status={tone}
      statusBlink={isLoading}
      titleSlot={
        <Flex align="baseline" gap="8px" minW={0}>
          <Text
            fontFamily="mono"
            fontSize="10px"
            letterSpacing="0.18em"
            textTransform="uppercase"
            fontWeight="600"
            color="ink2"
            whiteSpace="nowrap"
            overflow="hidden"
            textOverflow="ellipsis"
          >
            {sectorName}
          </Text>
          {countLabel !== null && (
            <Box
              as="span"
              fontFamily="mono"
              fontSize="10px"
              color="ink3"
              letterSpacing="0.12em"
              whiteSpace="nowrap"
            >
              {countLabel}
            </Box>
          )}
        </Flex>
      }
      right={
        <MonoButton
          icon="add"
          label="new sector"
          onClick={(): void => {
            setDialogOpen(true);
          }}
        />
      }
    >
      <Flex direction="column" h="100%" minH={0}>
        <FeatSecList bare />
        <Flex flex="1" minH={0} direction="column">
          <FeatEqList bare onCountsChange={onCountsChange} />
        </Flex>
      </Flex>
      <NewSectorDialog
        open={dialogOpen}
        onClose={(): void => {
          setDialogOpen(false);
        }}
      />
    </FeatView>
  );
}
