'use client';

/**
 * Minimal stock list for HK / US user sectors.
 *
 * Those markets are display-only in V1: there is no kline / snapshot /
 * column-filter pipeline behind them, so we render just a single CODE
 * column. The visual chrome mirrors the A-share `ScrollGrid` — header
 * row with mono caps label, sticky CODE column with glass tint, focus
 * highlight, virtualized rows — so an HK / US sector reads as the
 * same kind of pane.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { WatchMarket } from '@quant/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';
import { useStockUniverse } from '../../lib/hooks/use-stock-universe.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from '../feat-view/feat-view.js';
import { MonoButton } from '../ui/mono-button.js';

import { EditableTitle } from './list-headers.js';
import { DELETE_COL_W, ROW_H } from './list-types.js';

// HK / US rows show `name + code` in a single sticky cell — same as the
// A-share `makeCodeColumn`. The A-share sticky column is 110 px (just
// the code), but HK / US need wider because the names show in full
// instead of being squeezed into a separate metric column.
const NAME_CODE_W = 220;

interface BasicListProps {
  readonly sector: Sector;
  readonly market: WatchMarket;
  readonly bare?: boolean;
}

export function BasicList({ sector, market, bare }: BasicListProps): React.ReactElement {
  const { data: universe, isLoading } = useStockUniverse(market);
  const upsert = useSectorsStore((s) => s.upsert);
  const focusCode = useUiStore((s) => s.focusCode);
  const setFocusCode = useUiStore((s) => s.setFocusCode);
  const setVisibleCodes = useUiStore((s) => s.setVisibleCodes);
  const { guard, comp: confirmComp } = useConfirm();

  const codeToName = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of universe) m.set(r.code, r.name);
    return m;
  }, [universe]);

  const rows = useMemo(
    () =>
      sector.codes.map((code) => ({
        code,
        name: codeToName.get(code) ?? '—',
      })),
    [sector.codes, codeToName],
  );

  useEffect(() => {
    setVisibleCodes(rows.map((r) => r.code));
  }, [rows, setVisibleCodes]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  const onTitleSave = (next: string): void => {
    const t = next.trim();
    if (t.length === 0 || t === sector.name) return;
    upsert({ ...sector, name: t });
  };

  const onRemove = (code: string): void => {
    const name = codeToName.get(code);
    const display = name === undefined ? code : `${code} · ${name}`;
    guard({
      title: 'remove from sector',
      message: (
        <Text fontFamily="mono" fontSize="sm" color="ink2" lineHeight="1.7">
          remove{' '}
          <Text as="span" color="accent">
            {display}
          </Text>{' '}
          from{' '}
          <Text as="span" color="accent">
            {sector.name}
          </Text>
          ?
        </Text>
      ),
      confirmLabel: 'REMOVE',
    })
      .then(() => {
        const nextCodes = sector.codes.filter((c) => c !== code);
        upsert({ ...sector, codes: nextCodes, count: nextCodes.length });
      })
      .catch((e: unknown) => {
        if (e instanceof ConfirmCancelled) return;
        throw e;
      });
  };

  return (
    <FeatView
      feat={Feat.EquityList}
      bare={bare ?? false}
      status={isLoading ? 'amber' : 'green'}
      statusBlink={isLoading}
      titleSlot={
        <Flex align="baseline" gap="8px" minW={0}>
          <EditableTitle value={sector.name} editable onSave={onTitleSave} />
          <Box
            as="span"
            fontFamily="mono"
            fontSize="xs"
            color="ink3"
            letterSpacing="0.12em"
            whiteSpace="nowrap"
          >
            [{market}] {String(rows.length)}
          </Box>
        </Flex>
      }
    >
      <Flex direction="column" h="100%" minH={0}>
        {rows.length === 0 ? (
          <Box flex="1" overflow="auto" px="14px" py="14px">
            <Text fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.12em">
              // sector has no members — pick stocks above
            </Text>
          </Box>
        ) : (
          <Box ref={scrollRef} flex="1" overflow="auto" position="relative">
            {/* Column header — same chrome as the A-share ScrollGrid so
             *  HK / US sectors read as siblings of the A-share view. */}
            <Flex
              bg="glass.panelStrong"
              backdropFilter="blur(12px)"
              borderBottomWidth="1px"
              borderColor="line"
              flexShrink={0}
              position="sticky"
              top={0}
              zIndex={3}
            >
              <Box
                w={`${String(DELETE_COL_W)}px`}
                flexShrink={0}
                position="sticky"
                left={0}
                bg="glass.panelStrong"
                backdropFilter="blur(12px)"
                zIndex={4}
              />
              <Box
                w={`${String(NAME_CODE_W)}px`}
                px="8px"
                py="4px"
                textAlign="left"
                color="ink3"
                fontFamily="mono"
                fontSize="xs"
                letterSpacing="0.16em"
                textTransform="uppercase"
                fontWeight="700"
                position="sticky"
                left={`${String(DELETE_COL_W)}px`}
                bg="glass.panelStrong"
                backdropFilter="blur(12px)"
                zIndex={4}
                flexShrink={0}
              >
                CODE
              </Box>
            </Flex>
            <Box position="relative" h={`${String(virtualizer.getTotalSize())}px`}>
              {virtualizer.getVirtualItems().map((vi) => {
                const r = rows[vi.index];
                if (r === undefined) return null;
                const focused = r.code === focusCode;
                return (
                  <Flex
                    key={r.code}
                    position="absolute"
                    top={0}
                    left={0}
                    transform={`translateY(${String(vi.start)}px)`}
                    h={`${String(ROW_H)}px`}
                    align="center"
                    borderBottomWidth="1px"
                    borderColor="glass.line"
                    borderLeftWidth={focused ? '2px' : 0}
                    borderLeftColor="accent"
                    bg={focused ? 'accentBg' : 'transparent'}
                    cursor="pointer"
                    _hover={focused ? {} : { bg: 'hover' }}
                    onClick={(): void => {
                      setFocusCode(r.code);
                    }}
                    role="option"
                    aria-selected={focused}
                  >
                    <Box
                      position="sticky"
                      left={0}
                      h={`${String(ROW_H)}px`}
                      w={`${String(DELETE_COL_W)}px`}
                      display="grid"
                      placeItems="center"
                      bg="glass.panelStrong"
                      backdropFilter="blur(12px)"
                      boxShadow={
                        focused
                          ? 'inset 0 0 0 9999px var(--chakra-colors-accentBg)'
                          : undefined
                      }
                      zIndex={2}
                      flexShrink={0}
                    >
                      <MonoButton
                        icon="delete"
                        label={`remove ${r.code} from sector`}
                        onClick={(e: React.MouseEvent<HTMLButtonElement>): void => {
                          e.stopPropagation();
                          onRemove(r.code);
                        }}
                      />
                    </Box>
                    <Flex
                      w={`${String(NAME_CODE_W)}px`}
                      h={`${String(ROW_H)}px`}
                      px="8px"
                      py="2px"
                      align="baseline"
                      gap="6px"
                      position="sticky"
                      left={`${String(DELETE_COL_W)}px`}
                      bg="glass.panelStrong"
                      backdropFilter="blur(12px)"
                      boxShadow={
                        focused
                          ? 'inset 0 0 0 9999px var(--chakra-colors-accentBg)'
                          : undefined
                      }
                      zIndex={1}
                      fontFamily="mono"
                      fontSize="xs"
                      flexShrink={0}
                      minW={0}
                    >
                      <Text
                        color={focused ? 'accent' : 'ink'}
                        fontWeight="600"
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        {r.name}
                      </Text>
                      <Text color="ink3" letterSpacing="0.04em" flexShrink={0}>
                        {r.code}
                      </Text>
                    </Flex>
                  </Flex>
                );
              })}
            </Box>
          </Box>
        )}
      </Flex>
      {confirmComp}
    </FeatView>
  );
}
