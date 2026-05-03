'use client';

import { Box, Flex, HStack, Input, Text } from '@chakra-ui/react';
import type { StockMetaDto } from '@quant/shared';
import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { Pane } from './pane.js';

export function TopBar(): React.ReactElement {
  return (
    <Flex minH="42px" bg="panel" borderBottomWidth="2px" borderBottomColor="accent" align="stretch">
      <Brand />
      <Box flex="1" minW={0} />
      <CommandBar />
    </Flex>
  );
}

function Brand(): React.ReactElement {
  return (
    <HStack
      bg="accent"
      color="panel"
      h="100%"
      px="14px"
      gap="10px"
      letterSpacing="0.18em"
      fontWeight="700"
      fontSize="12px"
    >
      <Box
        position="relative"
        w="28px"
        h="28px"
        borderWidth="1.5px"
        borderColor="panel"
        display="grid"
        placeItems="center"
        fontFamily="mono"
        fontSize="14px"
        fontWeight="700"
      >
        Q
        <Box
          position="absolute"
          top="-3px"
          left="-3px"
          w="5px"
          h="5px"
          borderTopWidth="1.5px"
          borderLeftWidth="1.5px"
          borderColor="panel"
        />
        <Box
          position="absolute"
          bottom="-3px"
          right="-3px"
          w="5px"
          h="5px"
          borderBottomWidth="1.5px"
          borderRightWidth="1.5px"
          borderColor="panel"
        />
      </Box>
      <Box lineHeight="1.1">
        <Text>QUANT//OS</Text>
        <Text fontSize="9px" letterSpacing="0.22em" opacity={0.85} fontWeight="500">
          v0.1 · LOCAL
        </Text>
      </Box>
    </HStack>
  );
}

const MAX_DROPDOWN_VISIBLE = 5;
const DROPDOWN_ROW_PX = 30;
const SOFT_RESULT_CAP = 200;
const DROPDOWN_TRANSITION_MS = 180;

/**
 * Command bar — fast in-memory search by `code | name | pinyin`. Hits
 * land in a dropdown directly under the input; ↑/↓ move the highlight,
 * Enter focuses the highlighted code, Esc closes the panel.
 */
function CommandBar(): React.ReactElement {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const setFocusCode = useUiStore((s) => s.setFocusCode);
  const universe = useStockList();
  const dropdownRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(
    () => searchUniverse(universe.data ?? [], text, SOFT_RESULT_CAP),
    [universe.data, text],
  );

  // Keep the highlighted row valid as the result list mutates.
  useEffect(() => {
    if (highlight >= matches.length) setHighlight(0);
  }, [matches.length, highlight]);

  // Auto-scroll the highlighted row into view inside the dropdown.
  useEffect(() => {
    const container = dropdownRef.current;
    if (container === null) return;
    const child = container.querySelector(`[data-i="${String(highlight)}"]`);
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const commit = (code: string): void => {
    setFocusCode(code);
    setText('');
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (matches.length === 0 ? 0 : (h + 1) % matches.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (matches.length === 0 ? 0 : (h - 1 + matches.length) % matches.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = text.trim();
      if (matches.length > 0) {
        const row = matches[highlight] ?? matches[0]!;
        commit(row.code);
      } else if (/^\d{6}$/.test(t)) {
        commit(t);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const status =
    !open || text.trim().length === 0
      ? '↵ FOCUS'
      : `${matches.length} hit${matches.length === 1 ? '' : 's'}`;

  return (
    <Box
      flex="1"
      maxW="440px"
      minW="240px"
      borderLeftWidth="1px"
      borderLeftColor="line"
      position="relative"
    >
      <Pane feat={Feat.Search} right={<Text color="term.ink3">{status}</Text>}>
        <Flex
          h="100%"
          px="12px"
          align="center"
          gap="8px"
          bg="term.bg"
          position="relative"
          _before={{
            content: '""',
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background:
              'repeating-linear-gradient(to bottom, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px)',
          }}
        >
          <Text color="term.green" fontFamily="mono" fontSize="12px" fontWeight="600" zIndex={1}>
            &gt;
          </Text>
          <Input
            variant="outline"
            border="0"
            h="auto"
            minH="auto"
            p={0}
            bg="transparent"
            color="term.ink"
            fontFamily="mono"
            fontSize="13px"
            letterSpacing="0.04em"
            placeholder="code · name · pinyin"
            value={text}
            onChange={(e): void => {
              setText(e.target.value);
              setOpen(true);
              setHighlight(0);
            }}
            onFocus={(): void => {
              setOpen(true);
            }}
            onBlur={(): void => {
              // Defer so a click on the dropdown can land before close.
              window.setTimeout(() => {
                setOpen(false);
              }, 120);
            }}
            onKeyDown={onKey}
            zIndex={1}
            outline="none"
            outlineColor="transparent"
            outlineOffset={0}
            css={{ outline: 'none' }}
            _focus={{ boxShadow: 'none', outline: 'none' }}
            _focusVisible={{ boxShadow: 'none', outline: 'none' }}
          />
          <Text className="blink" color="term.green" fontWeight="700" fontFamily="mono" zIndex={1}>
            ▌
          </Text>
        </Flex>
      </Pane>
      <SearchDropdown
        ref={dropdownRef}
        open={open && text.trim().length > 0}
        matches={matches}
        highlight={highlight}
        onPick={commit}
        onHover={setHighlight}
      />
    </Box>
  );
}

interface DropdownProps {
  readonly open: boolean;
  readonly matches: readonly StockMetaDto[];
  readonly highlight: number;
  readonly onPick: (code: string) => void;
  readonly onHover: (i: number) => void;
}

const SearchDropdown = React.forwardRef<HTMLDivElement, DropdownProps>(function SearchDropdown(
  { open, matches, highlight, onPick, onHover },
  ref,
) {
  const maxH = MAX_DROPDOWN_VISIBLE * DROPDOWN_ROW_PX;
  // The container always renders so opening/closing animates max-height
  // and opacity. Pointer events fall back to `none` when collapsed so a
  // closed dropdown does not eat clicks beneath the input.
  const transition = `max-height ${String(DROPDOWN_TRANSITION_MS)}ms ease, opacity ${String(DROPDOWN_TRANSITION_MS)}ms ease`;
  return (
    <Box
      ref={ref}
      position="absolute"
      top="100%"
      left={0}
      right={0}
      zIndex={1500}
      bg="term.panel"
      borderWidth={open ? '1px' : 0}
      borderColor="term.line"
      borderTopWidth={0}
      overflowY="auto"
      pointerEvents={open ? 'auto' : 'none'}
      onMouseDown={(e): void => {
        // Prevent the input's blur (which would close us before the click
        // resolves) when the user picks an item with the mouse.
        e.preventDefault();
      }}
      style={{
        maxHeight: open ? `${String(maxH)}px` : '0px',
        opacity: open ? 1 : 0,
        transition,
      }}
    >
      {matches.length === 0 && open && (
        <Box px="12px" py="10px" fontFamily="mono" fontSize="11px" color="term.ink3">
          // no matches
        </Box>
      )}
      {matches.map((m: StockMetaDto, i: number) => {
        const active = i === highlight;
        return (
          <Box
            key={m.code}
            data-i={String(i)}
            onMouseEnter={(): void => {
              onHover(i);
            }}
            onClick={(): void => {
              onPick(m.code);
            }}
            display="grid"
            gridTemplateColumns="68px 1fr 60px"
            alignItems="center"
            gap="8px"
            px="12px"
            h={`${String(DROPDOWN_ROW_PX)}px`}
            bg={active ? 'term.line' : 'transparent'}
            cursor="pointer"
            fontFamily="mono"
            fontSize="12px"
          >
            <Text color={active ? 'term.green' : 'term.ink2'} fontWeight="600">
              {m.code}
            </Text>
            <Text color="term.ink" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
              {m.name}
            </Text>
            <Text
              color="term.ink3"
              fontSize="10px"
              textAlign="right"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {m.name_pinyin}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
});

function searchUniverse(
  rows: readonly StockMetaDto[],
  query: string,
  cap: number,
): readonly StockMetaDto[] {
  const term = query.trim().toLowerCase();
  if (term === '') return [];
  const out: StockMetaDto[] = [];
  for (const r of rows) {
    if (
      r.code.startsWith(term) ||
      r.name.toLowerCase().includes(term) ||
      r.name_pinyin.toLowerCase().includes(term)
    ) {
      out.push(r);
      if (out.length >= cap) break;
    }
  }
  return out;
}
