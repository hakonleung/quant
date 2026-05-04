'use client';

/**
 * E-1 list column manager (`docs/modules/07-frontend.md` §4.1.1).
 *
 * Two columns inside the modal: applied (ordered, removable, reorderable
 * via ↑ ↓ buttons) and available (the catalog ∖ applied, click + to
 * append). The CODE column is treated as immutable — it's hard-prepended
 * by the renderer and hidden here. Evidence columns are sector-driven
 * and do not appear in the dialog.
 *
 * Persistence flows through `useSettingsStore.setAppliedColumns`. The
 * dialog stages edits locally and only commits on SAVE so a CANCEL
 * leaves the persisted state untouched.
 */

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';

import {
  COLUMN_CATALOG,
  getColumnSpec,
  type ColumnKey,
  type ColumnSpec,
} from '../../lib/eqty/columns.catalog.js';
import { useSettingsStore } from '../../lib/stores/settings.store.js';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

const IMMUTABLE: ReadonlySet<ColumnKey> = new Set(['name']);

export function ColumnManagerDialog({ open, onClose }: Props): React.ReactElement | null {
  const persisted = useSettingsStore((s) => s.appliedColumns);
  const setAppliedColumns = useSettingsStore((s) => s.setAppliedColumns);
  const [draft, setDraft] = useState<readonly ColumnKey[]>(persisted);

  // Re-sync the draft when the dialog reopens or the persisted list
  // changes underneath (e.g. settings sync from another tab).
  useEffect(() => {
    if (open) setDraft(persisted);
  }, [open, persisted]);

  if (!open) return null;

  const removable = draft.filter((k) => !IMMUTABLE.has(k));
  const available: readonly ColumnSpec[] = COLUMN_CATALOG.filter(
    (s) => !draft.includes(s.key) && !IMMUTABLE.has(s.key),
  );

  const move = (idx: number, delta: number): void => {
    const next = [...removable];
    const j = idx + delta;
    if (j < 0 || j >= next.length) return;
    const tmp = next[idx]!;
    next[idx] = next[j]!;
    next[j] = tmp;
    setDraft(commitOrder(next));
  };

  const remove = (key: ColumnKey): void => {
    setDraft(commitOrder(removable.filter((k) => k !== key)));
  };

  const add = (key: ColumnKey): void => {
    setDraft(commitOrder([...removable, key]));
  };

  function commitOrder(removableNext: readonly ColumnKey[]): readonly ColumnKey[] {
    // Re-thread the immutable keys in their canonical position (CODE
    // first); keeps `applied` deterministic regardless of staging order.
    return ['name' as ColumnKey, ...removableNext];
  }

  const onSave = (): void => {
    setAppliedColumns(draft);
    onClose();
  };

  return (
    <Box
      position="fixed"
      inset={0}
      bg="rgba(0,0,0,0.45)"
      zIndex={2000}
      display="flex"
      alignItems="center"
      justifyContent="center"
      onClick={onClose}
    >
      <Box
        onClick={(e: React.MouseEvent): void => {
          e.stopPropagation();
        }}
        bg="panel"
        color="ink"
        w="640px"
        maxW="92vw"
        maxH="86vh"
        display="flex"
        flexDirection="column"
        borderWidth="1px"
        borderColor="accent"
        boxShadow="0 14px 48px rgba(0,0,0,0.55)"
      >
        <Flex
          align="center"
          gap="8px"
          px="14px"
          h="36px"
          borderBottomWidth="1px"
          borderColor="line"
          bg="panel3"
          flexShrink={0}
        >
          <Text
            fontFamily="mono"
            fontSize="11px"
            color="accent"
            fontWeight="700"
            letterSpacing="0.18em"
          >
            ⚙
          </Text>
          <Text
            fontFamily="mono"
            fontSize="11px"
            color="ink2"
            letterSpacing="0.18em"
            textTransform="uppercase"
          >
            manage columns
          </Text>
          <Text ml="auto" fontFamily="mono" fontSize="10px" color="ink3">
            // CODE is fixed; evidence columns auto-append per sector
          </Text>
        </Flex>
        <Flex flex="1" minH={0} borderBottomWidth="1px" borderColor="line">
          <PaneSection label="// APPLIED">
            {removable.length === 0 ? (
              <Empty>no extra columns selected</Empty>
            ) : (
              removable.map((key, idx) => {
                const spec = getColumnSpec(key);
                return (
                  <Flex
                    key={key}
                    align="center"
                    gap="6px"
                    px="10px"
                    py="6px"
                    borderBottomWidth="1px"
                    borderColor="line2"
                    fontFamily="mono"
                    fontSize="11px"
                    _hover={{ bg: 'hover' }}
                  >
                    <Text flex="1" color="ink">
                      {spec.label}
                    </Text>
                    <Text color="ink3" fontSize="9px">
                      {spec.group}
                    </Text>
                    <ToolButton
                      label="↑"
                      title="move up"
                      onClick={(): void => {
                        move(idx, -1);
                      }}
                      disabled={idx === 0}
                    />
                    <ToolButton
                      label="↓"
                      title="move down"
                      onClick={(): void => {
                        move(idx, 1);
                      }}
                      disabled={idx === removable.length - 1}
                    />
                    <ToolButton
                      label="×"
                      title="remove"
                      onClick={(): void => {
                        remove(key);
                      }}
                      danger
                    />
                  </Flex>
                );
              })
            )}
          </PaneSection>
          <PaneSection label="// AVAILABLE">
            {available.length === 0 ? (
              <Empty>every catalog column is already applied</Empty>
            ) : (
              available.map((spec) => (
                <Flex
                  key={spec.key}
                  align="center"
                  gap="6px"
                  px="10px"
                  py="6px"
                  borderBottomWidth="1px"
                  borderColor="line2"
                  fontFamily="mono"
                  fontSize="11px"
                  _hover={{ bg: 'hover' }}
                >
                  <Text flex="1" color="ink">
                    {spec.label}
                  </Text>
                  <Text color="ink3" fontSize="9px">
                    {spec.group}
                  </Text>
                  <ToolButton
                    label="+"
                    title="add to applied"
                    onClick={(): void => {
                      add(spec.key);
                    }}
                  />
                </Flex>
              ))
            )}
          </PaneSection>
        </Flex>
        <Flex
          align="center"
          gap="8px"
          px="14px"
          py="10px"
          borderTopWidth="1px"
          borderColor="line"
          bg="panel3"
          flexShrink={0}
        >
          <Button
            onClick={onClose}
            bg="transparent"
            color="ink2"
            borderWidth="1px"
            borderColor="line"
            h="auto"
            px="14px"
            py="6px"
            fontFamily="mono"
            fontSize="11px"
            letterSpacing="0.18em"
            borderRadius="0"
            _hover={{ borderColor: 'ink2' }}
          >
            CANCEL
          </Button>
          <Button
            ml="auto"
            onClick={onSave}
            bg="accent"
            color="panel"
            h="auto"
            px="16px"
            py="6px"
            fontFamily="mono"
            fontSize="11px"
            fontWeight="700"
            letterSpacing="0.18em"
            borderRadius="0"
            _hover={{ bg: 'accentDark' }}
          >
            SAVE
          </Button>
        </Flex>
      </Box>
    </Box>
  );
}

function PaneSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flex="1" overflow="auto" borderRightWidth="1px" borderColor="line" minW={0}>
      <Text
        px="10px"
        py="6px"
        fontFamily="mono"
        fontSize="9px"
        letterSpacing="0.18em"
        color="ink3"
        fontWeight="700"
        bg="panel3"
        position="sticky"
        top={0}
      >
        {label}
      </Text>
      {children}
    </Box>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text px="10px" py="10px" fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.12em">
      // {children}
    </Text>
  );
}

interface ToolButtonProps {
  readonly label: string;
  readonly title: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}

function ToolButton({
  label,
  title,
  onClick,
  disabled = false,
  danger = false,
}: ToolButtonProps): React.ReactElement {
  return (
    <Box
      as="button"
      onClick={(e: React.MouseEvent): void => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      title={title}
      color={disabled ? 'ink3' : danger ? 'down' : 'ink2'}
      bg="transparent"
      borderWidth="1px"
      borderColor="line"
      px="6px"
      h="20px"
      lineHeight="18px"
      fontFamily="mono"
      fontSize="11px"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.5 : 1}
      _hover={disabled ? {} : { borderColor: danger ? 'down' : 'accent', color: danger ? 'down' : 'accent' }}
    >
      {label}
    </Box>
  );
}
