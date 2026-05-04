'use client';

/**
 * Dropdown rendering for {@link StockCommandBar}.
 *
 * Rendered into a portal at the document root with `position: fixed`
 * anchored to the input's bounding rect — escapes the parent
 * `<Pane overflow="hidden">` clipping, which would otherwise hide the
 * suggestions when the search lives inside a Pane (e.g. the W-0 add
 * form).
 */

import { Box, Text } from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { UniverseStock } from '../../lib/hooks/use-stock-universe.js';

const MAX_DROPDOWN_VISIBLE = 5;
export const DROPDOWN_ROW_PX = 30;
const DROPDOWN_TRANSITION_MS = 180;

export interface DropdownProps {
  readonly open: boolean;
  readonly matches: readonly UniverseStock[];
  readonly highlight: number;
  readonly showMarketCol: boolean;
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  readonly onPick: (s: UniverseStock) => void;
  readonly onHover: (i: number) => void;
}

interface AnchorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

function useAnchorRect(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const update = (): void => {
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.bottom, width: r.width });
    };
    update();
    if (!open) return;
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return (): void => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [ref, open]);
  return rect;
}

export const SearchDropdown = React.forwardRef<HTMLDivElement, DropdownProps>(
  function SearchDropdown(props, ref) {
    const { open, matches, highlight, showMarketCol, anchorRef, onPick, onHover } = props;
    const rect = useAnchorRect(anchorRef, open);
    if (typeof document === 'undefined' || rect === null) return null;
    const maxH = MAX_DROPDOWN_VISIBLE * DROPDOWN_ROW_PX;
    const transition = `max-height ${String(DROPDOWN_TRANSITION_MS)}ms ease, opacity ${String(DROPDOWN_TRANSITION_MS)}ms ease`;
    const node = (
      <Box
        ref={ref}
        position="fixed"
        zIndex={1500}
        bg="term.panel"
        borderWidth={open ? '1px' : 0}
        borderColor="term.line"
        borderTopWidth={0}
        overflowY="auto"
        pointerEvents={open ? 'auto' : 'none'}
        onMouseDown={(e): void => {
          e.preventDefault();
        }}
        style={{
          left: `${String(rect.left)}px`,
          top: `${String(rect.top)}px`,
          width: `${String(rect.width)}px`,
          maxHeight: open ? `${String(maxH)}px` : '0px',
          opacity: open ? 1 : 0,
          transition,
        }}
      >
        <DropdownBody
          matches={matches}
          highlight={highlight}
          showMarketCol={showMarketCol}
          open={open}
          onPick={onPick}
          onHover={onHover}
        />
      </Box>
    );
    return createPortal(node, document.body);
  },
);

interface BodyProps {
  readonly matches: readonly UniverseStock[];
  readonly highlight: number;
  readonly showMarketCol: boolean;
  readonly open: boolean;
  readonly onPick: (s: UniverseStock) => void;
  readonly onHover: (i: number) => void;
}

function DropdownBody(props: BodyProps): React.ReactElement {
  const { matches, highlight, showMarketCol, open, onPick, onHover } = props;
  if (matches.length === 0) {
    if (!open) return <></>;
    return (
      <Box px="12px" py="10px" fontFamily="mono" fontSize="11px" color="term.ink3">
        // no matches
      </Box>
    );
  }
  return (
    <>
      {matches.map((m, i) => (
        <DropdownRow
          key={`${m.market}:${m.code}`}
          stock={m}
          index={i}
          active={i === highlight}
          showMarketCol={showMarketCol}
          onPick={onPick}
          onHover={onHover}
        />
      ))}
    </>
  );
}

interface RowProps {
  readonly stock: UniverseStock;
  readonly index: number;
  readonly active: boolean;
  readonly showMarketCol: boolean;
  readonly onPick: (s: UniverseStock) => void;
  readonly onHover: (i: number) => void;
}

function DropdownRow(p: RowProps): React.ReactElement {
  const { stock, index, active, showMarketCol, onPick, onHover } = p;
  const gridCols = showMarketCol ? '40px 68px 1fr 60px' : '68px 1fr 60px';
  return (
    <Box
      data-i={String(index)}
      onMouseEnter={(): void => {
        onHover(index);
      }}
      onClick={(): void => {
        onPick(stock);
      }}
      display="grid"
      gridTemplateColumns={gridCols}
      alignItems="center"
      gap="8px"
      px="12px"
      h={`${String(DROPDOWN_ROW_PX)}px`}
      bg={active ? 'term.line' : 'transparent'}
      cursor="pointer"
      fontFamily="mono"
      fontSize="12px"
    >
      {showMarketCol ? (
        <Text color={active ? 'term.green' : 'term.ink3'} fontSize="10px">
          [{stock.market}]
        </Text>
      ) : null}
      <Text color={active ? 'term.green' : 'term.ink2'} fontWeight="600">
        {stock.code}
      </Text>
      <Text color="term.ink" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
        {stock.name}
      </Text>
      <Text
        color="term.ink3"
        fontSize="10px"
        textAlign="right"
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
      >
        {stock.pinyin}
      </Text>
    </Box>
  );
}
