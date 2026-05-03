'use client';

import { Box, Button, Flex, HStack, Text } from '@chakra-ui/react';

import { useAnalyzeMany, useMarketSentiment } from '../../lib/hooks/use-eqty-data.js';
import { useBlacklistStore } from '../../lib/stores/blacklist.store.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { Pane } from '../shell/pane.js';

export function SectorsPanel(): React.ReactElement {
  const sectors = useSectorsStore((s) => s.sectors);
  const selectedIds = useSectorsStore((s) => s.selectedIds);
  const toggleSelect = useSectorsStore((s) => s.toggleSelect);
  const blacklist = useBlacklistStore((s) => s.entries);

  const userRows = sectors.filter((r) => r.kind === 'user');
  const dynRows = sectors.filter((r) => r.kind === 'dynamic');

  return (
    <Pane
      id="001"
      title="Sectors // Watchlists"
      gridArea="L"
      right={
        <Text cursor="pointer" _hover={{ color: 'accent' }}>
          + NEW
        </Text>
      }
    >
      <Flex direction="column" h="100%">
        <SideHead />
        <Box flex="1" overflow="auto">
          <SubHead label="// USER" />
          {userRows.length === 0 ? (
            <Empty>no user sectors yet</Empty>
          ) : (
            userRows.map((r) => (
              <SectorRow
                key={r.id}
                sector={r}
                selected={selectedIds.includes(r.id)}
                onClick={(): void => {
                  toggleSelect(r.id);
                }}
              />
            ))
          )}
          <SubHead label="// DYNAMIC" border />
          {dynRows.length === 0 ? (
            <Empty>no dynamic sectors yet</Empty>
          ) : (
            dynRows.map((r) => (
              <SectorRow
                key={r.id}
                sector={r}
                selected={selectedIds.includes(r.id)}
                onClick={(): void => {
                  toggleSelect(r.id);
                }}
              />
            ))
          )}
        </Box>
        <MergeBar selectedCount={selectedIds.length} />
        <Flex
          align="center"
          gap="8px"
          px="10px"
          h="28px"
          borderTopWidth="1px"
          borderColor="line"
          bg="panel"
          flexShrink={0}
        >
          <Text fontFamily="mono" fontSize="10px" letterSpacing="0.18em" fontWeight="700" color="accent">
            002
          </Text>
          <Text fontFamily="mono" fontSize="10px" letterSpacing="0.18em" textTransform="uppercase" fontWeight="600" color="ink2">
            Blacklist
          </Text>
          <Text ml="auto" fontFamily="mono" fontSize="10px" color="ink3">
            {blacklist.length}
          </Text>
        </Flex>
        <Box maxH="160px" overflow="auto">
          {blacklist.length === 0 ? (
            <Empty>no blacklisted stocks</Empty>
          ) : (
            blacklist.map((b) => (
              <Flex
                key={b.code}
                align="center"
                gap="8px"
                px="10px"
                py="6px"
                borderBottomWidth="1px"
                borderColor="line2"
                fontSize="11px"
                _hover={{ bg: 'hover' }}
              >
                <CheckBox />
                <Box>
                  <Text fontFamily="mono" fontSize="11px" color="ink" fontWeight="500" letterSpacing="0.04em">
                    {b.code} {b.name}
                  </Text>
                  <Text fontFamily="mono" fontSize="9px" color="ink3" letterSpacing="0.14em" mt="1px">
                    added {b.addedAt}
                  </Text>
                </Box>
              </Flex>
            ))
          )}
        </Box>
      </Flex>
    </Pane>
  );
}

function SideHead(): React.ReactElement {
  return (
    <Flex
      align="center"
      gap="6px"
      px="10px"
      py="8px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
      fontFamily="mono"
      fontSize="11px"
      color="ink2"
      flexShrink={0}
    >
      <Text color="prompt" fontWeight="700">
        $
      </Text>
      <Text>sectors --list</Text>
      <Text className="blink" color="prompt">
        ▌
      </Text>
    </Flex>
  );
}

function SubHead({ label, border = false }: { label: string; border?: boolean }): React.ReactElement {
  return (
    <Text
      px="10px"
      py="6px"
      fontFamily="mono"
      fontSize="9px"
      letterSpacing="0.18em"
      color="ink3"
      fontWeight="700"
      bg="panel3"
      borderTopWidth={border ? '1px' : 0}
      borderColor="line"
    >
      {label}
    </Text>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text px="10px" py="10px" fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.12em">
      // {children}
    </Text>
  );
}

interface RowProps {
  readonly sector: Sector;
  readonly selected: boolean;
  readonly onClick: () => void;
}

function SectorRow({ sector, selected, onClick }: RowProps): React.ReactElement {
  const codes = sector.codes;
  const cached = useMarketSentiment(codes);
  const analyze = useAnalyzeMany(codes);
  const themeCount = cached.data?.themeClusters.length ?? 0;

  const onAnalyze = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (codes.length === 0 || analyze.isPending) return;
    analyze.mutate();
  };

  return (
    <Flex
      align="center"
      gap="8px"
      px={selected ? '8px' : '10px'}
      py="6px"
      borderBottomWidth="1px"
      borderColor="line2"
      borderLeftWidth={selected ? '2px' : 0}
      borderLeftColor="accent"
      bg={selected ? 'accentBg' : 'transparent'}
      cursor="pointer"
      _hover={selected ? {} : { bg: 'hover' }}
      fontSize="11px"
      onClick={onClick}
    >
      <CheckBox checked={selected} />
      <Box flex="1" minW={0}>
        <Text fontFamily="mono" fontSize="11px" color="ink" fontWeight="500" letterSpacing="0.04em" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {sector.name}
        </Text>
        <Text fontFamily="mono" fontSize="9px" color="ink3" letterSpacing="0.14em" mt="1px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {sector.meta || `${String(sector.count)} members`}
          {themeCount > 0 ? ` · themed:${String(themeCount)}` : ''}
        </Text>
      </Box>
      {sector.chgPct !== null && (
        <Text fontFamily="mono" color={sector.chgPct >= 0 ? 'up' : 'down'} fontWeight="600">
          {sector.chgPct >= 0 ? '+' : ''}
          {sector.chgPct.toFixed(2)}%
        </Text>
      )}
      <AnalyzeBtn
        onClick={onAnalyze}
        loading={analyze.isPending}
        empty={codes.length === 0}
        themed={themeCount > 0}
      />
    </Flex>
  );
}

interface AnalyzeBtnProps {
  readonly onClick: (e: React.MouseEvent) => void;
  readonly loading: boolean;
  readonly empty: boolean;
  readonly themed: boolean;
}

function AnalyzeBtn({ onClick, loading, empty, themed }: AnalyzeBtnProps): React.ReactElement {
  return (
    <Button
      ml="2px"
      h="20px"
      px="6px"
      bg={themed ? 'accentBg' : 'panel'}
      color={themed ? 'accent' : 'ink3'}
      borderWidth="1px"
      borderColor={themed ? 'accent' : 'line'}
      fontFamily="mono"
      fontSize="9px"
      letterSpacing="0.12em"
      fontWeight="700"
      borderRadius="0"
      onClick={onClick}
      loading={loading}
      disabled={empty}
      _hover={empty ? {} : { borderColor: 'accent', color: 'accent' }}
      title={empty ? 'no members' : 'analyze members'}
    >
      ⌘
    </Button>
  );
}

function CheckBox({ checked = false }: { checked?: boolean }): React.ReactElement {
  return (
    <Box
      w="12px"
      h="12px"
      borderWidth="1px"
      borderColor={checked ? 'accent' : 'ink3'}
      bg={checked ? 'accent' : 'panel'}
      color={checked ? 'panel' : 'accent'}
      display="grid"
      placeItems="center"
      fontSize="10px"
      lineHeight="1"
      flexShrink={0}
    >
      {checked ? '✓' : ''}
    </Box>
  );
}

function MergeBar({ selectedCount }: { selectedCount: number }): React.ReactElement {
  const enabled = selectedCount >= 2;
  return (
    <HStack
      px="10px"
      py="8px"
      borderTopWidth="1px"
      borderColor="line"
      bg="panel3"
      fontFamily="mono"
      fontSize="10px"
      color="ink3"
      letterSpacing="0.14em"
      fontWeight="700"
      flexShrink={0}
    >
      <Text>SEL={selectedCount}</Text>
      <Button
        ml="auto"
        bg={enabled ? 'accent' : 'badgeBg'}
        color={enabled ? 'panel' : 'ink3'}
        h="auto"
        px="12px"
        py="5px"
        fontFamily="mono"
        fontSize="10px"
        fontWeight="600"
        letterSpacing="0.16em"
        borderRadius="0"
        disabled={!enabled}
        _hover={enabled ? { bg: 'accentDark' } : {}}
      >
        MERGE →
      </Button>
    </HStack>
  );
}
