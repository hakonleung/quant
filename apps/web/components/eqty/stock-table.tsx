'use client';

/**
 * Virtualised stock list (modules/07-frontend.md §4.1, §5).
 *
 * The table is the workhorse for stock-list / sector-detail / blacklist
 * views. It owns no data — callers pass `rows` from a hook and a
 * `onRowAction` callback for context actions.
 */

import { Box, Flex, Input, Text } from '@chakra-ui/react';
import type { StockMetaDto } from '@quant/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';

interface Props {
  readonly rows: readonly StockMetaDto[];
  readonly emptyHint: string;
  readonly onRowClick?: (row: StockMetaDto) => void;
  /** Code of the currently focused stock — that row is highlighted. */
  readonly focusedCode?: string | null;
}

export function StockTable({ rows, emptyHint, onRowClick, focusedCode = null }: Props): React.ReactElement {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterRows(rows, query), [rows, query]);

  return (
    <Flex direction="column" h="100%" minH={0}>
      <SearchBar query={query} setQuery={setQuery} total={rows.length} hits={filtered.length} />
      <Header />
      <VirtualBody
        rows={filtered}
        emptyHint={emptyHint}
        onRowClick={onRowClick}
        focusedCode={focusedCode}
      />
    </Flex>
  );
}

function filterRows(rows: readonly StockMetaDto[], q: string): readonly StockMetaDto[] {
  const term = q.trim().toLowerCase();
  if (term === '') return rows;
  return rows.filter(
    (r) =>
      r.code.startsWith(term) ||
      r.name.toLowerCase().includes(term) ||
      r.name_pinyin.toLowerCase().includes(term),
  );
}

interface SearchProps {
  readonly query: string;
  readonly setQuery: (v: string) => void;
  readonly total: number;
  readonly hits: number;
}

function SearchBar({ query, setQuery, total, hits }: SearchProps): React.ReactElement {
  return (
    <Flex
      align="center"
      gap="10px"
      px="14px"
      py="8px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
    >
      <Text color="prompt" fontFamily="mono" fontSize="12px" fontWeight="700">
        $
      </Text>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="filter --code|name|pinyin"
        bg="panel"
        borderWidth="1px"
        borderColor="line"
        h="28px"
        px="10px"
        fontFamily="mono"
        fontSize="12px"
        borderRadius="0"
        _focus={{ borderColor: 'accent', boxShadow: 'none' }}
      />
      <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.14em">
        {hits}/{total}
      </Text>
    </Flex>
  );
}

const COLS: readonly { k: keyof StockMetaDto | 'industries'; label: string; w: string; align?: 'left' | 'right' }[] = [
  { k: 'code', label: 'CODE', w: '90px' },
  { k: 'name', label: 'NAME', w: '160px' },
  { k: 'name_pinyin', label: 'PY', w: '160px' },
  { k: 'industries', label: 'INDUSTRY', w: 'minmax(160px, 1fr)' },
  { k: 'list_date', label: 'LIST', w: '110px' },
  { k: 'float_pct', label: 'FLOAT', w: '80px', align: 'right' },
];

function Header(): React.ReactElement {
  return (
    <Box
      display="grid"
      gridTemplateColumns={COLS.map((c) => c.w).join(' ')}
      gap="0"
      bg="panel3"
      borderBottomWidth="1px"
      borderColor="line"
    >
      {COLS.map((c) => (
        <Text
          key={c.label}
          px="10px"
          py="6px"
          textAlign={c.align ?? 'left'}
          color="ink3"
          fontFamily="mono"
          fontSize="10px"
          letterSpacing="0.16em"
          textTransform="uppercase"
          fontWeight="700"
        >
          {c.label}
        </Text>
      ))}
    </Box>
  );
}

interface BodyProps {
  readonly rows: readonly StockMetaDto[];
  readonly emptyHint: string;
  readonly onRowClick: ((row: StockMetaDto) => void) | undefined;
  readonly focusedCode: string | null;
}

function VirtualBody({ rows, emptyHint, onRowClick, focusedCode }: BodyProps): React.ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  if (rows.length === 0) {
    return (
      <Box flex="1" overflow="auto" px="14px" py="14px">
        <Text fontFamily="mono" fontSize="11px" color="ink3" letterSpacing="0.12em">
          // {emptyHint}
        </Text>
      </Box>
    );
  }

  return (
    <Box ref={parentRef} flex="1" overflow="auto">
      <Box position="relative" h={`${String(rowVirtualizer.getTotalSize())}px`}>
        {rowVirtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (row === undefined) return null;
          const focused = focusedCode !== null && row.code === focusedCode;
          return (
            <Box
              key={vi.key}
              position="absolute"
              top={0}
              left={0}
              right={0}
              transform={`translateY(${String(vi.start)}px)`}
              h={`${String(vi.size)}px`}
              display="grid"
              gridTemplateColumns={COLS.map((c) => c.w).join(' ')}
              borderBottomWidth="1px"
              borderColor="line2"
              borderLeftWidth={focused ? '2px' : 0}
              borderLeftColor="accent"
              bg={focused ? 'accentBg' : 'transparent'}
              cursor={onRowClick === undefined ? 'default' : 'pointer'}
              _hover={focused ? {} : { bg: 'hover' }}
              onClick={(): void => {
                onRowClick?.(row);
              }}
            >
              {COLS.map((c) => (
                <Text
                  key={c.label}
                  px="10px"
                  py="6px"
                  fontFamily={c.k === 'code' ? 'mono' : undefined}
                  fontSize="11px"
                  color="ink"
                  textAlign={c.align ?? 'left'}
                  overflow="hidden"
                  textOverflow="ellipsis"
                  whiteSpace="nowrap"
                >
                  {String(row[c.k as keyof StockMetaDto] ?? '')}
                </Text>
              ))}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
