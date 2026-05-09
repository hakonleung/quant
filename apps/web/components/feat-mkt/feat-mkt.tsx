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

import { Flex } from '@chakra-ui/react';
import { useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useBlacklistQuery } from '../../lib/hooks/use-blacklist.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
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
  const tone =
    stocks.error !== null
      ? 'red'
      : stocks.isLoading || blacklist.isLoading
        ? 'amber'
        : 'green';
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <FeatView
      feat={Feat.Mkt}
      status={tone}
      statusBlink={stocks.isLoading}
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
          <FeatEqList bare />
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
