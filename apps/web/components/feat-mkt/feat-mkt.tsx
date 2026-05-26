'use client';

/**
 * MKT — sector chip slider, single-row floating pane.
 *
 * Now a thin wrapper around `<FeatSecList bare/>`: the slider itself
 * carries the cross-sector navigation; this Feat exposes it as its own
 * floating island in the left column and owns the `+ new sector`
 * affordance.
 *
 * As of the 2026-05 floating-island split, MKT no longer also hosts
 * the equity list — `<FeatEqList>` mounts as its own pane in the same
 * column. Earlier MKT.MAIN-style combined pane is gone.
 */

import { useState } from 'react';
import { useIsFetching } from '@tanstack/react-query';

import { Feat } from '../../lib/eqty/feat.js';
import { useBlacklistQuery } from '../../lib/hooks/use-blacklist.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useFeatHotkeys } from '../../lib/ui-cmd/hooks/use-feat-hotkeys.js';
import { NewSectorDialog } from '../feat-sec-list/new-sector-dialog.js';
import { FeatSecList } from '../feat-sec-list/feat-sec-list.js';
import { FeatView } from '../feat-view/feat-view.js';
import { MonoButton } from '../ui/mono-button.js';

export function FeatMkt(): React.ReactElement {
  // Sector / blacklist hydration + any in-flight kline batches drive
  // the header status dot — same as the old combined pane, just scoped
  // to the slider's own upstreams now that EQ.LIST owns its dot.
  const stocks = useStockList();
  const blacklist = useBlacklistQuery();
  const eqtyFetching =
    useIsFetching({ queryKey: ['kline.bulk'] }) + useIsFetching({ queryKey: ['stock.snapshots'] });
  const isLoading = stocks.isLoading || blacklist.isLoading || eqtyFetching > 0;
  const tone = stocks.error !== null ? 'red' : isLoading ? 'amber' : 'green';
  const [dialogOpen, setDialogOpen] = useState(false);

  // `N` — keyboard equivalent of the header's "+ new sector" button.
  useFeatHotkeys(Feat.Mkt, {
    'ui.sector-new-open': () => setDialogOpen(true),
  });

  return (
    <FeatView
      feat={Feat.Mkt}
      contentSized
      status={tone}
      statusBlink={isLoading}
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
      <FeatSecList bare />
      <NewSectorDialog
        open={dialogOpen}
        onClose={(): void => {
          setDialogOpen(false);
        }}
      />
    </FeatView>
  );
}
