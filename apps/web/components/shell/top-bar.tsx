'use client';

import { Box, Flex, HStack, Text } from '@chakra-ui/react';
import React from 'react';

import { useUiStore } from '../../lib/stores/ui.store.js';
import { SearchPane } from '../eqty/stock-command-bar.js';

export function TopBar(): React.ReactElement {
  return (
    <Flex minH="42px" bg="panel" borderBottomWidth="2px" borderBottomColor="accent" align="stretch">
      <Brand />
      <Box flex="1" minW={0} />
      <CommandBar />
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

/**
 * M-0 — top-bar fast in-memory search by `code | name | pinyin`.
 * Restricts to A-stock universe; picking a hit focuses the workbench
 * on that code.
 */
function CommandBar(): React.ReactElement {
  const onPick = (s: { readonly code: string }): void => {
    useUiStore.getState().setFocusCode(s.code);
  };
  return (
    <Box
      flex="1"
      maxW="440px"
      minW="240px"
      borderLeftWidth="1px"
      borderLeftColor="line"
      position="relative"
    >
      <SearchPane marketFilter="a" onPick={onPick} />
    </Box>
  );
}
