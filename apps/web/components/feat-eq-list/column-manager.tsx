'use client';

/**
 * EQ.LIST column manager (`docs/modules/07-frontend.md` §4.1.1).
 *
 * Two side-by-side sections — `APPLIED` (ordered, removable, reorderable
 * via ↑ ↓ buttons) and `AVAILABLE` (the catalog ∖ applied, click + to
 * append). The CODE column is treated as immutable — it's hard-prepended
 * by the renderer and hidden here. Evidence columns are sector-driven
 * and do not appear here.
 *
 * Edits commit immediately to {@link useSettingsStore.setAppliedColumns}
 * — the row was previously gated behind a modal Save button but the
 * inline panel host (SYS.CFG) keeps the surface lightweight.
 */

import { Box, Flex, Text } from '@chakra-ui/react';

import {
  COLUMN_CATALOG,
  getColumnSpec,
  type ColumnKey,
  type ColumnSpec,
} from '../../lib/eqty/columns.catalog.js';
import { useSettingsStore } from '../../lib/stores/settings.store.js';

const IMMUTABLE: ReadonlySet<ColumnKey> = new Set(['name']);

export function ColumnManager(): React.ReactElement {
  const persisted = useSettingsStore((s) => s.appliedColumns);
  const setAppliedColumns = useSettingsStore((s) => s.setAppliedColumns);

  const removable = persisted.filter((k) => !IMMUTABLE.has(k));
  const available: readonly ColumnSpec[] = COLUMN_CATALOG.filter(
    (s) => !persisted.includes(s.key) && !IMMUTABLE.has(s.key),
  );

  const commitOrder = (removableNext: readonly ColumnKey[]): readonly ColumnKey[] => {
    // Re-thread the immutable keys in their canonical position (CODE
    // first); keeps `applied` deterministic regardless of mutation order.
    return ['name' as ColumnKey, ...removableNext];
  };

  const move = (idx: number, delta: number): void => {
    const next = [...removable];
    const j = idx + delta;
    if (j < 0 || j >= next.length) return;
    const tmp = next[idx]!;
    next[idx] = next[j]!;
    next[j] = tmp;
    setAppliedColumns(commitOrder(next));
  };

  const remove = (key: ColumnKey): void => {
    setAppliedColumns(commitOrder(removable.filter((k) => k !== key)));
  };

  const add = (key: ColumnKey): void => {
    setAppliedColumns(commitOrder([...removable, key]));
  };

  return (
    <Flex h="100%" minH={0} minW={0}>
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
                borderColor="term.line"
                fontFamily="mono"
                fontSize="11px"
                _hover={{ bg: 'term.bgElev' }}
              >
                <Text flex="1" color="term.ink" whiteSpace="nowrap">
                  {spec.label}
                </Text>
                <Text color="term.ink3" fontSize="9px" whiteSpace="nowrap">
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
              borderColor="term.line"
              fontFamily="mono"
              fontSize="11px"
              _hover={{ bg: 'term.bgElev' }}
            >
              <Text flex="1" color="term.ink" whiteSpace="nowrap">
                {spec.label}
              </Text>
              <Text color="term.ink3" fontSize="9px" whiteSpace="nowrap">
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
    <Box
      flex="0 0 220px"
      overflowY="auto"
      overflowX="hidden"
      borderRightWidth="1px"
      borderColor="term.line"
      minW="220px"
      h="100%"
    >
      <Text
        px="10px"
        py="6px"
        fontFamily="mono"
        fontSize="9px"
        letterSpacing="0.18em"
        color="term.ink3"
        fontWeight="700"
        bg="term.panel"
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
    <Text
      px="10px"
      py="10px"
      fontFamily="mono"
      fontSize="10px"
      color="term.ink3"
      letterSpacing="0.12em"
    >
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
      color={disabled ? 'term.ink3' : danger ? 'term.red' : 'term.ink2'}
      bg="transparent"
      borderWidth="1px"
      borderColor="term.line"
      px="6px"
      h="20px"
      lineHeight="18px"
      fontFamily="mono"
      fontSize="11px"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.5 : 1}
      _hover={
        disabled
          ? {}
          : {
              borderColor: danger ? 'term.red' : 'term.green',
              color: danger ? 'term.red' : 'term.green',
            }
      }
    >
      {label}
    </Box>
  );
}
