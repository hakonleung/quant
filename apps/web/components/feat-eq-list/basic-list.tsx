'use client';

/**
 * Minimal stock list for HK / US user sectors.
 *
 * Those markets are display-only in V1: there is no kline / snapshot /
 * column-filter pipeline behind them, so we render just the basic
 * `{ code, name }` rows joined from the watch universe (`/api/watch/universe`).
 * The sector still uses the shared persistence (members live in `sector.codes`);
 * users add stocks via the M-0 picker and remove via the inline delete.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { WatchMarket } from '@quant/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';
import {
  useStockUniverse,
  type UniverseStock,
} from '../../lib/hooks/use-stock-universe.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { FeatScrNl } from '../feat-scr-nl/feat-scr-nl.js';
import { FeatView } from '../feat-view/feat-view.js';
import { MonoButton } from '../ui/mono-button.js';

import { EditableTitle } from './list-headers.js';
import { ROW_H } from './list-types.js';

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

  const onAdd = (s: UniverseStock): void => {
    if (sector.codes.includes(s.code)) return;
    const nextCodes = [...sector.codes, s.code];
    upsert({ ...sector, codes: nextCodes, count: nextCodes.length });
  };

  const onBatchAdd = (stocks: readonly UniverseStock[]): void => {
    const existing = new Set(sector.codes);
    const nextCodes = [...sector.codes];
    for (const s of stocks) {
      if (existing.has(s.code)) continue;
      existing.add(s.code);
      nextCodes.push(s.code);
    }
    if (nextCodes.length === sector.codes.length) return;
    upsert({ ...sector, codes: nextCodes, count: nextCodes.length });
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
        <Box flexShrink={0}>
          <FeatScrNl
            marketFilter={market}
            onPick={(s): void => {
              onAdd(s);
            }}
            onBatchPick={(stocks): void => {
              onBatchAdd(stocks);
            }}
          />
        </Box>
        <Box ref={scrollRef} flex="1" overflow="auto" minH={0}>
          {rows.length === 0 ? (
            <Text px="10px" py="14px" fontFamily="mono" fontSize="xs" color="ink3">
              // sector has no members — pick stocks above
            </Text>
          ) : (
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
                    right={0}
                    h={`${String(ROW_H)}px`}
                    transform={`translateY(${String(vi.start)}px)`}
                    align="center"
                    gap="10px"
                    px="10px"
                    fontFamily="mono"
                    fontSize="xs"
                    cursor="pointer"
                    bg={focused ? 'accentBg' : 'transparent'}
                    color={focused ? 'ink' : 'ink2'}
                    _hover={focused ? {} : { bg: 'hover' }}
                    borderBottomWidth="1px"
                    borderColor="line"
                    onClick={(): void => {
                      setFocusCode(r.code);
                    }}
                  >
                    <Text w="90px" color={focused ? 'accent' : 'ink'} fontWeight="600">
                      {r.code}
                    </Text>
                    <Text flex="1" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                      {r.name}
                    </Text>
                    <MonoButton
                      icon="delete"
                      label={`remove ${r.code} from sector`}
                      onClick={(e: React.MouseEvent<HTMLButtonElement>): void => {
                        e.stopPropagation();
                        onRemove(r.code);
                      }}
                    />
                  </Flex>
                );
              })}
            </Box>
          )}
        </Box>
      </Flex>
      {confirmComp}
    </FeatView>
  );
}
