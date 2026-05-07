'use client';

/**
 * Top bar — brand mark + SYS.STAT (live capsules) + SYS.CFG (settings).
 *
 * SYS.STAT used to live at the bottom of the page; mounting it here
 * keeps the live SSE / queue / mem / fps capsules in the user's eye
 * line at all times.
 *
 * SYS.CFG is the catch-all for persisted UI settings — blacklist and
 * the EQ.LIST column manager. It replaces the SEC.BLACK side-pane and
 * the ⚙ gear that used to sit on the EQ.LIST header.
 *
 * The cross-market search input (M-0 / SCR.NL) has been removed from
 * the top-bar; picking now happens from inside individual panes.
 */

import { Box, Flex, HStack, Text } from '@chakra-ui/react';

import { FeatSysCfg } from '../feat-sys-cfg/feat-sys-cfg.js';
import { FeatSysStat } from '../feat-sys-stat/feat-sys-stat.js';

export function TopBar(): React.ReactElement {
  return (
    <Flex minH="42px" bg="panel" borderBottomWidth="2px" borderBottomColor="accent" align="stretch">
      <Brand />
      <Box flex="1" minW={0} display="flex" alignItems="stretch">
        <FeatSysStat />
      </Box>
      <Box w="220px" flex="0 0 auto" display="flex" alignItems="stretch">
        <FeatSysCfg />
      </Box>
    </Flex>
  );
}

function Brand(): React.ReactElement {
  return (
    <HStack
      bg="accent"
      color="panel"
      h="100%"
      px="14px"
      gap="6px"
      letterSpacing="0.18em"
      fontWeight="700"
      fontSize="12px"
      flexShrink={0}
    >
      <Box lineHeight="1.1">
        <HStack gap="0" align="baseline">
          <Text as="span">qX//OS</Text>
          <Text as="span" ml="4px" css={{ animation: 'blink 1s steps(1) infinite' }}>
            _
          </Text>
        </HStack>
        <Text fontSize="9px" letterSpacing="0.22em" opacity={0.85} fontWeight="500">
          v0.1 · LOCAL
        </Text>
      </Box>
    </HStack>
  );
}
