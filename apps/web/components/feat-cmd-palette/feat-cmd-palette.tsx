'use client';

/**
 * Command palette — global ⌘K / Ctrl+K surface.
 *
 * Aggregates the four "central hub" actions the workbench was missing
 * before this sprint:
 *   1. Stocks   — focus a stock by code or pinyin / name fragment
 *   2. Sectors  — switch the active sector
 *   3. Layout   — apply a built-in preset
 *   4. Mode     — toggle workbench / terminal
 *
 * Mounted at the AppShell level. Closes on Esc, scrim click, or
 * after a command runs. Keyboard-only navigation: ↑/↓ to move the
 * cursor inside the result list, Enter to commit, /code/ for a
 * direct stock-code shortcut.
 *
 * The command set is rebuilt on every open from the live stores so
 * the palette is always in sync with the latest sectors / focused
 * stock. Stock entries are ranked by a small fuzzy scorer (substring
 * priority, then position-weighted) — good enough at 5 500 rows.
 */

import { Box, Flex, Input, Text } from '@chakra-ui/react';
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { useFocusTrap } from '../../lib/fp/use-focus-trap.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useCmdPaletteStore } from '../../lib/stores/cmd-palette.store.js';
import {
  BUILTIN_PRESETS,
  useLayoutStore,
  type LayoutPreset,
} from '../../lib/stores/layout.store.js';
import { useSectorsStore } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';

import { filterCmdItems, type CmdItem } from './cmd-filter.js';

const MAX_STOCK_RESULTS = 30;

export function FeatCmdPalette(): ReactElement | null {
  const open = useCmdPaletteStore((s) => s.open);
  const setOpen = useCmdPaletteStore((s) => s.setOpen);
  if (!open) return null;
  return <CmdPaletteBody onClose={(): void => setOpen(false)} />;
}

interface CmdPaletteBodyProps {
  readonly onClose: () => void;
}

function CmdPaletteBody({ onClose }: CmdPaletteBodyProps): ReactElement {
  const query = useCmdPaletteStore((s) => s.query);
  const setQuery = useCmdPaletteStore((s) => s.setQuery);
  const items = useCmdItems(onClose);
  const filtered = useMemo(
    () => filterCmdItems(items, query, MAX_STOCK_RESULTS),
    [items, query],
  );
  const [cursor, setCursor] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  // Reset cursor whenever the filtered list changes — keeps the
  // selection on row 0 so the first Enter is always the top hit.
  useEffect(() => {
    setCursor(0);
  }, [query, items.length]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(filtered.length - 1, c + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[cursor];
      if (target !== undefined) target.run();
      return;
    }
  };

  return (
    <Flex
      position="fixed"
      inset="0"
      zIndex={1500}
      align="flex-start"
      justify="center"
      pt={{ base: '12vh', md: '16vh' }}
      bg="rgba(15,17,22,0.55)"
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      onMouseDown={(e): void => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      <Box
        ref={dialogRef}
        onKeyDown={onKeyDown}
        bg="panel"
        color="ink"
        w={{ base: '92vw', md: '560px' }}
        maxW="92vw"
        maxH="70vh"
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
          h="44px"
          borderBottomWidth="1px"
          borderColor="line"
        >
          <Text
            fontFamily="mono"
            fontSize="11px"
            color="accent"
            fontWeight="700"
            letterSpacing="0.18em"
          >
            CMD
          </Text>
          <Input
            autoFocus
            value={query}
            onChange={(e): void => {
              setQuery(e.currentTarget.value);
            }}
            placeholder="输入股票代码 / 名称 / 板块 / 操作"
            size="sm"
            bg="transparent"
            border="0"
            fontFamily="mono"
            fontSize="13px"
            color="ink"
            _focus={{ outline: 'none', boxShadow: 'none' }}
            flex="1"
          />
          <Text fontFamily="mono" fontSize="9px" color="ink3" letterSpacing="0.16em">
            ESC
          </Text>
        </Flex>
        <Box flex="1" minH={0} overflow="auto">
          {filtered.length === 0 ? (
            <Flex align="center" justify="center" h="80px">
              <Text fontFamily="mono" fontSize="11px" color="ink3">
                没有匹配的项
              </Text>
            </Flex>
          ) : (
            <ResultList
              items={filtered}
              cursor={cursor}
              setCursor={setCursor}
              onCommit={(item): void => {
                item.run();
              }}
            />
          )}
        </Box>
        <Flex
          align="center"
          gap="14px"
          px="14px"
          h="28px"
          borderTopWidth="1px"
          borderColor="line"
          fontFamily="mono"
          fontSize="9px"
          color="ink3"
          letterSpacing="0.14em"
        >
          <span>↑↓ navigate</span>
          <span>↵ commit</span>
          <span>esc close</span>
        </Flex>
      </Box>
    </Flex>
  );
}

interface ResultListProps {
  readonly items: readonly CmdItem[];
  readonly cursor: number;
  readonly setCursor: (n: number) => void;
  readonly onCommit: (item: CmdItem) => void;
}

function ResultList({ items, cursor, setCursor, onCommit }: ResultListProps): ReactElement {
  // Active row scrolls into view so keyboard navigation past the
  // visible viewport doesn't strand the selection off-screen.
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);
  let lastCategory: CmdItem['category'] | null = null;
  return (
    <Box>
      {items.map((item, idx) => {
        const showHeader = item.category !== lastCategory;
        lastCategory = item.category;
        return (
          <div key={item.id}>
            {showHeader && <CategoryHeader category={item.category} />}
            <ResultRow
              item={item}
              active={idx === cursor}
              {...(idx === cursor ? { innerRef: activeRef } : {})}
              onMouseEnter={(): void => {
                setCursor(idx);
              }}
              onClick={(): void => {
                onCommit(item);
              }}
            />
          </div>
        );
      })}
    </Box>
  );
}

const CATEGORY_LABEL: Record<CmdItem['category'], string> = {
  stock: 'STOCKS',
  sector: 'SECTORS',
  layout: 'LAYOUT',
  mode: 'MODE',
};

function CategoryHeader({ category }: { readonly category: CmdItem['category'] }): ReactElement {
  return (
    <Box
      px="14px"
      pt="10px"
      pb="4px"
      fontFamily="mono"
      fontSize="9px"
      letterSpacing="0.18em"
      color="ink3"
      fontWeight="700"
      textTransform="uppercase"
    >
      {CATEGORY_LABEL[category]}
    </Box>
  );
}

interface ResultRowProps {
  readonly item: CmdItem;
  readonly active: boolean;
  readonly innerRef?: React.Ref<HTMLDivElement>;
  readonly onMouseEnter: () => void;
  readonly onClick: () => void;
}

function ResultRow({
  item,
  active,
  innerRef,
  onMouseEnter,
  onClick,
}: ResultRowProps): ReactElement {
  return (
    <Flex
      ref={innerRef}
      role="option"
      aria-selected={active}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      align="baseline"
      gap="8px"
      px="14px"
      py="6px"
      cursor="pointer"
      bg={active ? 'accentBg' : 'transparent'}
      borderLeftWidth="2px"
      borderLeftColor={active ? 'accent' : 'transparent'}
    >
      <Text fontFamily="mono" fontSize="13px" color={active ? 'accent' : 'ink'}>
        {item.title}
      </Text>
      {item.subtitle !== undefined && (
        <Text
          fontFamily="mono"
          fontSize="10px"
          color="ink3"
          flex="1"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {item.subtitle}
        </Text>
      )}
    </Flex>
  );
}

/* -------------------------- command sources -------------------------- */

function useCmdItems(onClose: () => void): readonly CmdItem[] {
  const setFocusCode = useUiStore((s) => s.setFocusCode);
  const setActiveSector = useUiStore((s) => s.setActiveSector);
  const sectors = useSectorsStore((s) => s.sectors);
  const setAppMode = useLayoutStore((s) => s.setAppMode);
  const applyPreset = useLayoutStore((s) => s.applyPreset);
  const stocksQ = useStockList();
  const stocks = stocksQ.data ?? [];

  return useMemo(() => {
    const items: CmdItem[] = [];
    items.push({
      id: 'mode-term',
      category: 'mode',
      title: '进入终端模式',
      subtitle: 'TERM.MAIN — 键盘驱动命令面板',
      run: () => {
        setAppMode('term');
        onClose();
      },
    });
    items.push({
      id: 'mode-regular',
      category: 'mode',
      title: '回到工作台',
      subtitle: 'regular workbench',
      run: () => {
        setAppMode('regular');
        onClose();
      },
    });
    for (const p of BUILTIN_PRESETS) items.push(layoutItem(p, applyPreset, onClose));
    items.push({
      id: 'sector-all',
      category: 'sector',
      title: '全部',
      subtitle: 'ALL · 不过滤板块',
      run: () => {
        setActiveSector(ALL_SECTOR_ID);
        onClose();
      },
    });
    for (const s of sectors) {
      items.push({
        id: `sector-${s.id}`,
        category: 'sector',
        title: s.name,
        subtitle: `${s.kind} · ${String(s.codes.length)} codes`,
        run: () => {
          setActiveSector(s.id);
          onClose();
        },
      });
    }
    for (const s of stocks) {
      items.push({
        id: `stock-${s.code}`,
        category: 'stock',
        title: `${s.code} ${s.name}`,
        ...(s.industries === '' ? {} : { subtitle: s.industries }),
        run: () => {
          setFocusCode(s.code);
          onClose();
        },
      });
    }
    return items;
  }, [stocks, sectors, setFocusCode, setActiveSector, setAppMode, applyPreset, onClose]);
}

function layoutItem(
  preset: LayoutPreset,
  apply: (id: string) => void,
  onClose: () => void,
): CmdItem {
  return {
    id: `layout-${preset.id}`,
    category: 'layout',
    title: `布局 · ${preset.label}`,
    ...(preset.description !== undefined ? { subtitle: preset.description } : {}),
    run: () => {
      apply(preset.id);
      onClose();
    },
  };
}

