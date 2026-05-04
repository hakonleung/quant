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

import { SysConfigPane } from './sys-config-pane.js';
import { SysStatPane } from './sys-stat-pane.js';

export function TopBar(): React.ReactElement {
  return (
    <Flex minH="42px" bg="panel" borderBottomWidth="2px" borderBottomColor="accent" align="stretch">
      <Brand />
      <Box flex="1" minW={0} display="flex" alignItems="stretch">
        <SysStatPane />
      </Box>
      <Box w="220px" flex="0 0 auto" display="flex" alignItems="stretch">
        <SysConfigPane />
      </Box>
    </Flex>
  );
}

function BrandGlyph(): React.ReactElement {
  return (
    <Box
      position="relative"
      w="28px"
      h="28px"
      borderWidth="1.5px"
      borderColor="panel"
      display="grid"
      placeItems="center"
      fontFamily="mono"
      fontSize="14px"
      fontWeight="700"
    >
      Q
      <Box
        position="absolute"
        top="-3px"
        left="-3px"
        w="5px"
        h="5px"
        borderTopWidth="1.5px"
        borderLeftWidth="1.5px"
        borderColor="panel"
      />
      <Box
        position="absolute"
        bottom="-3px"
        right="-3px"
        w="5px"
        h="5px"
        borderBottomWidth="1.5px"
        borderRightWidth="1.5px"
        borderColor="panel"
      />
    </Box>
  );
}

function Brand(): React.ReactElement {
  return (
    <HStack
      bg="accent"
      color="panel"
      h="100%"
      px="14px"
      gap="10px"
      letterSpacing="0.18em"
      fontWeight="700"
      fontSize="12px"
      flexShrink={0}
    >
      <BrandGlyph />
      <Box lineHeight="1.1">
        <Text>QUANT//OS</Text>
        <Text fontSize="9px" letterSpacing="0.22em" opacity={0.85} fontWeight="500">
          v0.1 · LOCAL
        </Text>
      </Box>
    </HStack>
  );
}
