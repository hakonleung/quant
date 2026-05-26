'use client';

/**
 * Multi-select dialog for managing a stock's user-sector membership.
 *
 * Replaces the older append-only `add-to-sector` flow. Default
 * selection mirrors the stock's current memberships across user
 * sectors; toggling a row adds or removes the code on apply. Dynamic
 * sectors are listed as informational rows (their members are
 * computed by the backend screener — they aren't user-mutable here).
 *
 * Apply semantics (one pass over the user sectors, single mutation
 * per changed sector):
 *   inNext &&  inPrev → unchanged
 *   inNext && !inPrev → add code
 *  !inNext &&  inPrev → remove code
 *  !inNext && !inPrev → unchanged
 */

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { DialogPortal } from '../feat-view/dialog-portal.js';
import { useEffect, useMemo, useState } from 'react';

import {
  computeMembershipDiff,
  initialMembershipSelection,
} from '../../lib/fp/sector-membership.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';

interface Props {
  readonly open: boolean;
  readonly code: string;
  readonly onClose: () => void;
}

export function SelectSectorsDialog({ open, code, onClose }: Props): React.ReactElement | null {
  const sectors = useSectorsStore((s) => s.sectors);
  const upsert = useSectorsStore((s) => s.upsert);
  const userSectors = useMemo(() => sectors.filter((s) => s.kind === 'user'), [sectors]);
  const dynamicSectors = useMemo(() => sectors.filter((s) => s.kind === 'dynamic'), [sectors]);

  const initial = useMemo<ReadonlySet<string>>(
    () => initialMembershipSelection(userSectors, code),
    [userSectors, code],
  );

  const [selected, setSelected] = useState<ReadonlySet<string>>(initial);

  // Reset to current memberships every time the dialog opens for a
  // potentially different stock — the parent doesn't unmount us.
  useEffect(() => {
    if (open) setSelected(initial);
  }, [open, initial]);

  if (!open) return null;

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const apply = (): void => {
    const diff = computeMembershipDiff(userSectors, code, selected);
    for (const { sector, nextCodes } of diff.added) {
      upsert({ ...sector, codes: nextCodes, count: nextCodes.length });
    }
    for (const { sector, nextCodes } of diff.removed) {
      upsert({ ...sector, codes: nextCodes, count: nextCodes.length });
    }
    onClose();
  };

  const dirty = !setEquals(selected, initial);

  return (
    <DialogPortal>
      <Flex
        position="fixed"
        top={0}
        left={0}
        w="100vw"
        h="100vh"
        bg="overlay"
        align="center"
        justify="center"
        zIndex="dialog"
        onClick={onClose}
      >
        <Box
          role="dialog"
          aria-modal="true"
          aria-labelledby="select-sectors-dialog-title"
          className="glass-strong"
          borderWidth="1px"
          borderRadius="lg"
          boxShadow="glassStrong"
          w="380px"
          maxH="80vh"
          display="flex"
          flexDirection="column"
          onClick={(e): void => {
            e.stopPropagation();
          }}
        >
          <Flex
            id="select-sectors-dialog-title"
            align="center"
            gap="8px"
            px="14px"
            py="10px"
            borderBottomWidth="1px"
            borderColor="glass.line"
            bg="glass.panelSoft"
            backdropFilter="blur(12px)"
            fontFamily="mono"
            fontSize="xs"
            letterSpacing="0.18em"
            color="ink2"
            fontWeight="600"
            textTransform="uppercase"
          >
            select sectors for {code}
          </Flex>
          <Box flex="1" overflow="auto" maxH="50vh">
            {userSectors.length === 0 ? (
              <Text px="14px" py="14px" fontFamily="mono" fontSize="xs" color="ink3">
                // no user sectors — create one in SEC.LIST first
              </Text>
            ) : (
              userSectors.map((s) => {
                const checked = selected.has(s.id);
                return (
                  <Flex
                    key={s.id}
                    align="center"
                    gap="8px"
                    px="14px"
                    py="8px"
                    borderBottomWidth="1px"
                    borderColor="glass.line"
                    cursor="pointer"
                    _hover={{ bg: 'hover' }}
                    onClick={(): void => {
                      toggle(s.id);
                    }}
                  >
                    <Checkbox checked={checked} />
                    <Text fontFamily="mono" fontSize="sm" color="ink" flex="1">
                      {s.name}
                    </Text>
                    <Text fontFamily="mono" fontSize="xs" color="ink3">
                      {`${String(s.codes.length)} members`}
                    </Text>
                  </Flex>
                );
              })
            )}
            {dynamicSectors.length > 0 && <DynamicSection sectors={dynamicSectors} code={code} />}
          </Box>
          <Flex
            gap="8px"
            px="14px"
            py="10px"
            borderTopWidth="1px"
            borderColor="glass.line"
            bg="glass.panelSoft"
            backdropFilter="blur(12px)"
            justify="flex-end"
          >
            <Button
              h="28px"
              px="14px"
              bg="panel"
              color="ink2"
              borderWidth="1px"
              borderColor="line"
              borderRadius="sm"
              fontFamily="mono"
              fontSize="xs"
              onClick={onClose}
            >
              cancel
            </Button>
            <Button
              h="28px"
              px="14px"
              bg="accent"
              color="panel"
              borderRadius="sm"
              fontFamily="mono"
              fontSize="xs"
              disabled={!dirty}
              onClick={apply}
            >
              apply
            </Button>
          </Flex>
        </Box>
      </Flex>
    </DialogPortal>
  );
}

function Checkbox({ checked }: { checked: boolean }): React.ReactElement {
  return (
    <Box
      w="12px"
      h="12px"
      borderWidth="1px"
      borderColor={checked ? 'accent' : 'ink3'}
      bg={checked ? 'accent' : 'panel'}
      color="panel"
      display="grid"
      placeItems="center"
      fontSize="xs"
      flexShrink={0}
    >
      {checked ? '✓' : ''}
    </Box>
  );
}

function DynamicSection({
  sectors,
  code,
}: {
  sectors: readonly Sector[];
  code: string;
}): React.ReactElement {
  return (
    <Box>
      <Text
        px="14px"
        py="6px"
        fontFamily="mono"
        fontSize="xs"
        letterSpacing="0.18em"
        color="ink3"
        fontWeight="700"
        bg="glass.panelSoft"
        backdropFilter="blur(12px)"
        borderTopWidth="1px"
        borderBottomWidth="1px"
        borderColor="glass.line"
      >
        // DYNAMIC (read-only)
      </Text>
      {sectors.map((s) => {
        const has = s.codes.includes(code);
        return (
          <Flex
            key={s.id}
            align="center"
            gap="8px"
            px="14px"
            py="8px"
            borderBottomWidth="1px"
            borderColor="glass.line"
            opacity={0.6}
            cursor="not-allowed"
          >
            <Box w="12px" h="12px" flexShrink={0} />
            <Text fontFamily="mono" fontSize="sm" color="ink" flex="1">
              [D] {s.name}
            </Text>
            <Text fontFamily="mono" fontSize="xs" color={has ? 'accent' : 'ink3'}>
              {has ? 'matches' : 'no match'}
            </Text>
          </Flex>
        );
      })}
    </Box>
  );
}

function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
