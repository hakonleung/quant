'use client';

/**
 * Shows the current user's display name + a logout link. Mounted into
 * the topbar after SYS.CFG. Stays minimal so it fits the existing chip
 * row at compact widths.
 */

import { Box, Flex } from '@chakra-ui/react';

interface UserChipProps {
  readonly displayName: string;
  readonly mode: 'oauth' | 'env' | 'im';
}

export function UserChip({ displayName, mode }: UserChipProps): React.ReactElement {
  return (
    <Flex h="100%" align="center" px="10px" gap="8px" fontSize="11px" color="textMuted">
      <Box
        as="span"
        title={mode === 'env' ? 'AUTH_MODE=disabled' : 'logged in'}
        maxW="120px"
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
      >
        {displayName}
      </Box>
      {mode !== 'env' && (
        <form method="POST" action="/api/auth/logout">
          <button
            type="submit"
            style={{
              color: 'inherit',
              cursor: 'pointer',
              border: 0,
              background: 'transparent',
              fontSize: '11px',
              padding: 0,
            }}
          >
            登出
          </button>
        </form>
      )}
    </Flex>
  );
}
