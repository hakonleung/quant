'use client';

/**
 * Mobile EQTY shell — single Feat at a time, swapped via the bottom
 * `MobileTabBar`. Five tabs cover the day-to-day flow (LIST / CHART /
 * AI / LDG / WATCH); SEC.LIST rides at the top of LIST so sector
 * switching never requires leaving the list view.
 *
 * Empty states (e.g. CHART without a focused code) are rendered inline
 * so the user never lands on a blank pane without an explanation.
 */

import { Box, Flex, Text } from '@chakra-ui/react';

import { useUiStore } from '../../lib/stores/ui.store.js';
import { FeatAiEq } from '../feat-ai-eq/feat-ai-eq.js';
import { FeatAiSec } from '../feat-ai-sec/feat-ai-sec.js';
import { FeatEqChart } from '../feat-eq-chart/feat-eq-chart.js';
import { FeatEqList } from '../feat-eq-list/feat-eq-list.js';
import { FeatLedger } from '../feat-ledger/feat-ledger.js';
import { FeatSecList } from '../feat-sec-list/feat-sec-list.js';
import { FeatWatchLive } from '../feat-watch-live/feat-watch-live.js';
import { MobileTabBar } from '../shell/mobile-tab-bar.js';

export function EqtyModuleMobile(): React.ReactElement {
  const tab = useUiStore((s) => s.mobileTab);
  const code = useUiStore((s) => s.focusCode);
  return (
    <Flex direction="column" h="100%" bg="line" gap="0">
      <Box flex="1" minH={0} bg="panel" overflow="hidden" display="flex" flexDirection="column">
        {tab === 'list' && (
          <Flex direction="column" h="100%" gap="1px" bg="line">
            <FeatSecList />
            <FeatEqList />
          </Flex>
        )}
        {tab === 'chart' && (code !== null ? <FeatEqChart code={code} /> : <EmptyChart />)}
        {tab === 'ai' && (
          <Flex direction="column" h="100%" gap="1px" bg="line" overflowY="auto">
            <FeatAiSec />
            {code !== null && <FeatAiEq code={code} />}
          </Flex>
        )}
        {tab === 'ledger' && <FeatLedger />}
        {tab === 'watch' && <FeatWatchLive />}
      </Box>
      <MobileTabBar />
    </Flex>
  );
}

function EmptyChart(): React.ReactElement {
  return (
    <Flex flex="1" align="center" justify="center" px="20px">
      <Text
        fontFamily="mono"
        fontSize="12px"
        color="ink3"
        textAlign="center"
        letterSpacing="0.04em"
        lineHeight="1.6"
      >
        请先在 LIST 标签里选中一只股票
      </Text>
    </Flex>
  );
}
