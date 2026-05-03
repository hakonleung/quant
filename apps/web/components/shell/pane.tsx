'use client';

import { Box, Flex, HStack, Text } from '@chakra-ui/react';
import type { ReactNode } from 'react';

interface PaneProps {
  readonly id: string;
  readonly title: string;
  readonly right?: ReactNode;
  readonly children: ReactNode;
  readonly cyber?: boolean;
  readonly gridArea?: string;
}

export function Pane({ id, title, right, children, cyber = false, gridArea }: PaneProps): React.ReactElement {
  return (
    <Box
      bg={cyber ? 'term.panel' : 'panel'}
      color={cyber ? 'term.ink2' : 'ink'}
      position="relative"
      gridArea={gridArea}
      display="flex"
      flexDirection="column"
      overflow="hidden"
      _before={{
        content: '""',
        position: 'absolute',
        top: '-1px',
        left: '-1px',
        w: '8px',
        h: '8px',
        borderTopWidth: '1px',
        borderLeftWidth: '1px',
        borderColor: cyber ? 'term.green' : 'accent',
        opacity: 0.55,
        zIndex: 2,
        pointerEvents: 'none',
      }}
      _after={{
        content: '""',
        position: 'absolute',
        bottom: '-1px',
        right: '-1px',
        w: '8px',
        h: '8px',
        borderBottomWidth: '1px',
        borderRightWidth: '1px',
        borderColor: cyber ? 'term.green' : 'accent',
        opacity: 0.55,
        zIndex: 2,
        pointerEvents: 'none',
      }}
    >
      <PaneHeader id={id} title={title} right={right} cyber={cyber} />
      <Box flex="1" minH={0}>
        {children}
      </Box>
    </Box>
  );
}

interface HeaderProps {
  readonly id: string;
  readonly title: string;
  readonly right?: ReactNode;
  readonly cyber: boolean;
}

function PaneHeader({ id, title, right, cyber }: HeaderProps): React.ReactElement {
  return (
    <Flex
      align="center"
      gap="8px"
      px="10px"
      h={cyber ? '30px' : '28px'}
      bg={cyber ? 'term.panel' : 'panel'}
      borderBottomWidth="1px"
      borderBottomColor={cyber ? 'term.line' : 'line'}
      flexShrink={0}
    >
      <Text
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.18em"
        fontWeight="700"
        color={cyber ? 'term.green' : 'accent'}
      >
        {id}
      </Text>
      <Text
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.18em"
        textTransform="uppercase"
        fontWeight="600"
        color={cyber ? 'term.ink2' : 'ink2'}
      >
        {title}
      </Text>
      {right !== undefined && (
        <HStack
          ml="auto"
          gap="10px"
          fontFamily="mono"
          fontSize="10px"
          letterSpacing="0.06em"
          color={cyber ? 'term.ink3' : 'ink3'}
        >
          {right}
        </HStack>
      )}
    </Flex>
  );
}
