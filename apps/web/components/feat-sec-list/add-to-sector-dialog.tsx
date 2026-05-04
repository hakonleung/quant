'use client';

/**
 * Modal that adds a code to one or more user sectors. Triggered from
 * the 101 chart pane action. Apply mutates each selected sector's
 * `codes` set (de-duped) via the persisted sectors store.
 */

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';

import { useSectorsStore } from '../../lib/stores/sectors.store.js';

interface Props {
  readonly open: boolean;
  readonly code: string;
  readonly onClose: () => void;
}

export function AddToSectorDialog({ open, code, onClose }: Props): React.ReactElement | null {
  const sectors = useSectorsStore((s) => s.sectors);
  const upsert = useSectorsStore((s) => s.upsert);
  const userSectors = sectors.filter((s) => s.kind === 'user');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (open) setSelected(new Set());
  }, [open]);

  if (!open) return null;

  const apply = (): void => {
    for (const sector of userSectors) {
      if (!selected.has(sector.id)) continue;
      if (sector.codes.includes(code)) continue;
      const nextCodes = [...sector.codes, code];
      upsert({ ...sector, codes: nextCodes, count: nextCodes.length });
    }
    onClose();
  };

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Flex
      position="fixed"
      top={0}
      left={0}
      w="100vw"
      h="100vh"
      bg="rgba(15,17,22,0.55)"
      align="center"
      justify="center"
      zIndex={1100}
      onClick={onClose}
    >
      <Box
        bg="panel"
        borderWidth="1px"
        borderColor="line"
        w="360px"
        maxH="80vh"
        display="flex"
        flexDirection="column"
        onClick={(e): void => {
          e.stopPropagation();
        }}
      >
        <Flex
          align="center"
          gap="8px"
          px="14px"
          py="10px"
          borderBottomWidth="1px"
          borderColor="line"
          bg="panel3"
          fontFamily="mono"
          fontSize="11px"
          letterSpacing="0.18em"
          color="ink2"
          fontWeight="600"
          textTransform="uppercase"
        >
          add {code} to sectors
        </Flex>
        <Box flex="1" overflow="auto" maxH="50vh">
          {userSectors.length === 0 ? (
            <Text px="14px" py="14px" fontFamily="mono" fontSize="11px" color="ink3">
              // no user sectors — create one in 002 first
            </Text>
          ) : (
            userSectors.map((s) => {
              const has = s.codes.includes(code);
              const checked = selected.has(s.id);
              return (
                <Flex
                  key={s.id}
                  align="center"
                  gap="8px"
                  px="14px"
                  py="8px"
                  borderBottomWidth="1px"
                  borderColor="line2"
                  cursor={has ? 'not-allowed' : 'pointer'}
                  opacity={has ? 0.5 : 1}
                  _hover={has ? {} : { bg: 'hover' }}
                  onClick={(): void => {
                    if (!has) toggle(s.id);
                  }}
                >
                  <Box
                    w="12px"
                    h="12px"
                    borderWidth="1px"
                    borderColor={checked ? 'accent' : 'ink3'}
                    bg={checked ? 'accent' : 'panel'}
                    color="panel"
                    display="grid"
                    placeItems="center"
                    fontSize="9px"
                    flexShrink={0}
                  >
                    {checked ? '✓' : ''}
                  </Box>
                  <Text fontFamily="mono" fontSize="12px" color="ink" flex="1">
                    {s.name}
                  </Text>
                  <Text fontFamily="mono" fontSize="10px" color="ink3">
                    {has ? 'already in' : `${String(s.codes.length)} members`}
                  </Text>
                </Flex>
              );
            })
          )}
        </Box>
        <Flex gap="8px" px="14px" py="10px" borderTopWidth="1px" borderColor="line" justify="flex-end">
          <Button
            h="28px"
            px="14px"
            bg="panel"
            color="ink2"
            borderWidth="1px"
            borderColor="line"
            borderRadius="0"
            fontFamily="mono"
            fontSize="11px"
            onClick={onClose}
          >
            cancel
          </Button>
          <Button
            h="28px"
            px="14px"
            bg="accent"
            color="panel"
            borderRadius="0"
            fontFamily="mono"
            fontSize="11px"
            disabled={selected.size === 0}
            onClick={apply}
          >
            apply
          </Button>
        </Flex>
      </Box>
    </Flex>
  );
}
