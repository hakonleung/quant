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

import { Box, Flex } from '@chakra-ui/react';

import { useUiStore } from '../../lib/stores/ui.store.js';
import { FeatAiEq } from '../feat-ai-eq/feat-ai-eq.js';
import { FeatAiSec } from '../feat-ai-sec/feat-ai-sec.js';
import { FeatEqChart } from '../feat-eq-chart/feat-eq-chart.js';
import { FeatMkt } from '../feat-mkt/feat-mkt.js';
import { FeatSysMain } from '../feat-sys-main/feat-sys-main.js';
import { FeatUsrMain } from '../feat-usr-main/feat-usr-main.js';
import { MobileTabBar } from '../shell/mobile-tab-bar.js';
import { EmptyState } from '../ui/empty-state.js';

export function EqtyModuleMobile(): React.ReactElement {
  const tab = useUiStore((s) => s.mobileTab);
  const code = useUiStore((s) => s.focusCode);
  return (
    <Flex direction="column" h="100%" bg="line" gap="0">
      <Box flex="1" minH={0} bg="panel" overflow="hidden" display="flex" flexDirection="column">
        {tab === 'list' && <FeatMkt />}
        {tab === 'chart' && (code !== null ? <FeatEqChart code={code} /> : <EmptyChart />)}
        {tab === 'ai' && (
          <Flex direction="column" h="100%" gap="1px" bg="line" overflowY="auto">
            <FeatAiSec />
            {code !== null && <FeatAiEq code={code} />}
          </Flex>
        )}
        {tab === 'sys' && <FeatSysMain embedded="mobile" />}
        {tab === 'usr' && <FeatUsrMain embedded="mobile" />}
      </Box>
      <MobileTabBar />
    </Flex>
  );
}

function EmptyChart(): React.ReactElement {
  return <EmptyState title="未选中股票" body={'切到 LIST 标签，点一只\n股票后再回来。'} />;
}
