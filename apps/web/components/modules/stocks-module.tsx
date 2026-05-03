'use client';

/**
 * Module 01 §6 — Stocks Universe.
 * Virtualised browse + search of all stock-meta rows. Clicking a row
 * focuses the EQTY workbench on that code.
 */

import { Box, Text } from '@chakra-ui/react';

import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { StockTable } from '../eqty/stock-table.js';
import { Pane } from '../shell/pane.js';

export function StocksModule(): React.ReactElement {
  const setFocus = useUiStore((s) => s.setFocusCode);
  const setView = useUiStore((s) => s.setView);
  const { data, isLoading, error } = useStockList();

  return (
    <Box h="100%" p="1px" bg="line">
      <Pane id="010" title="Stocks · Universe" right={<Text>{data?.length ?? 0} rows</Text>}>
        {isLoading ? (
          <Box p="14px" fontFamily="mono" fontSize="11px" color="ink3">
            loading universe…
          </Box>
        ) : error !== null ? (
          <Box p="14px" fontFamily="mono" fontSize="11px" color="up">
            // {(error as Error).message}
          </Box>
        ) : (
          <StockTable
            rows={data ?? []}
            emptyHint="universe empty (run an orchestrator sync)"
            onRowClick={(row): void => {
              setFocus(row.code);
              setView('eqty');
            }}
          />
        )}
      </Pane>
    </Box>
  );
}
