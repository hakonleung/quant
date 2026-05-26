'use client';

/**
 * Reusable stock-search input + dropdown (M-0 / W-0 §11.1).
 *
 * Browser-side fuzzy match over the cross-market universe — no per-key
 * RPC. Consumers pass `marketFilter` to constrain to A / HK / US, and
 * `onPick` to receive the picked `(market, code, name)`. The dropdown
 * shows the market column when no filter is supplied so the user can
 * see and disambiguate hits across markets.
 */

import { Box, Flex, Input, Text } from '@chakra-ui/react';
import type { WatchMarket } from '@quant/shared';
import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import {
  matchBatch,
  tryParseBatchInput,
  type BatchMatchResult,
} from '../../lib/fp/batch-stock-match.js';
import { useStockUniverse, type UniverseStock } from '../../lib/hooks/use-stock-universe.js';
import { FeatView } from '../feat-view/feat-view.js';
import { FeatViewStatus } from '../feat-view/feat-view-header.js';
import { BatchPanel } from './batch-panel.js';
import { SearchDropdown } from './stock-search-dropdown.js';

const SOFT_RESULT_CAP = 200;
const BLUR_CLOSE_DELAY_MS = 120;

export interface StockCommandBarProps {
  readonly marketFilter?: WatchMarket;
  readonly onPick: (stock: UniverseStock) => void;
  readonly placeholder?: string;
  readonly autoFocus?: boolean;
  /**
   * `cyber` matches the M-0 top-bar style (>/▌ prompt + scanline);
   * `plain` is a bare Chakra input for embedding in a form.
   */
  readonly variant?: 'cyber' | 'plain';
  /**
   * Optional batch handler. When set, pasting a JSON `string[]` into
   * the box switches to batch mode: an Apply button matches each entry
   * across A / HK / US and invokes this callback with the resolved
   * universe rows. `marketFilter` is ignored in batch mode — the
   * matching rules dispatch each entry to a market by shape.
   */
  readonly onBatchPick?: (stocks: readonly UniverseStock[]) => void;
  /**
   * Live notification on every text change — used by the All-sector
   * SEARCH pane to drive a filter on EQ.LIST without waiting for a
   * pick. Independent of `onPick`; the dropdown still surfaces match
   * options on top of any filter behaviour the consumer wires up.
   */
  readonly onTextChange?: (text: string) => void;
  /**
   * Suppress the search dropdown. Use for the ALL-sector filter wiring
   * where the input only drives a live filter on EQ.LIST below — the
   * dropdown duplicates that affordance and steals click focus.
   */
  readonly hideDropdown?: boolean;
}

/**
 * Full M-0 pane — the same widget the top-bar exposes, parameterized
 * by `marketFilter` / `onPick`. Lifted into a separate component so
 * W-0 (`<WatchAddForm/>`) can drop it inline without re-implementing
 * the cyber chrome.
 *
 * Note: both instances share `Feat.ScreenNL` layout state on purpose —
 * v0 doesn't multiplex pane storage by location.
 */
export function FeatScrNl({
  marketFilter,
  onPick,
  onBatchPick,
  onTextChange,
  rightSlot,
  hideDropdown,
}: {
  readonly marketFilter?: WatchMarket;
  readonly onPick: (stock: UniverseStock) => void;
  readonly onBatchPick?: (stocks: readonly UniverseStock[]) => void;
  readonly onTextChange?: (text: string) => void;
  readonly rightSlot?: React.ReactNode;
  readonly hideDropdown?: boolean;
}): React.ReactElement {
  return (
    <FeatView feat={Feat.ScreenNL} right={rightSlot ?? <FeatViewStatus tone="green" />}>
      <StockCommandBar
        {...(marketFilter !== undefined ? { marketFilter } : {})}
        {...(onBatchPick !== undefined ? { onBatchPick } : {})}
        {...(onTextChange !== undefined ? { onTextChange } : {})}
        {...(hideDropdown === true ? { hideDropdown: true } : {})}
        onPick={onPick}
      />
    </FeatView>
  );
}

interface SearchState {
  readonly text: string;
  readonly setText: (s: string) => void;
  readonly open: boolean;
  readonly setOpen: (o: boolean) => void;
  readonly highlight: number;
  readonly setHighlight: (n: number) => void;
  readonly matches: readonly UniverseStock[];
  readonly dropdownRef: React.RefObject<HTMLDivElement>;
  readonly commit: (row: UniverseStock) => void;
  readonly onKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  readonly onBlurDeferred: () => void;
}

function useSearchState(props: StockCommandBarProps): SearchState {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const universe = useStockUniverse(props.marketFilter);

  const matches = useMemo(
    () => searchUniverse(universe.data, text, SOFT_RESULT_CAP),
    [universe.data, text],
  );

  useEffect(() => {
    if (highlight >= matches.length) setHighlight(0);
  }, [matches.length, highlight]);

  useEffect(() => {
    const container = dropdownRef.current;
    if (container === null) return;
    const child = container.querySelector(`[data-i="${String(highlight)}"]`);
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const commit = (row: UniverseStock): void => {
    props.onPick(row);
    setText('');
    setOpen(false);
    // Pick clears the input — mirror that to any text subscriber so
    // the All-sector filter doesn't stay stuck on the previous query.
    props.onTextChange?.('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    handleKey(e, matches, { highlight, setHighlight, setOpen, commit });
  };

  const onBlurDeferred = (): void => {
    window.setTimeout(() => {
      setOpen(false);
    }, BLUR_CLOSE_DELAY_MS);
  };

  return {
    text,
    setText,
    open,
    setOpen,
    highlight,
    setHighlight,
    matches,
    dropdownRef,
    commit,
    onKey,
    onBlurDeferred,
  };
}

interface KeyHelpers {
  readonly highlight: number;
  readonly setHighlight: (n: number) => void;
  readonly setOpen: (o: boolean) => void;
  readonly commit: (row: UniverseStock) => void;
}

function handleKey(
  e: KeyboardEvent<HTMLInputElement>,
  matches: readonly UniverseStock[],
  h: KeyHelpers,
): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    h.setOpen(true);
    h.setHighlight(matches.length === 0 ? 0 : (h.highlight + 1) % matches.length);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    h.setOpen(true);
    h.setHighlight(matches.length === 0 ? 0 : (h.highlight - 1 + matches.length) % matches.length);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const row = matches[h.highlight] ?? matches[0];
    if (row !== undefined) h.commit(row);
  } else if (e.key === 'Escape') {
    h.setOpen(false);
  }
}

export function StockCommandBar(props: StockCommandBarProps): React.ReactElement {
  const s = useSearchState(props);
  const anchorRef = useRef<HTMLDivElement>(null);
  const placeholder = props.placeholder ?? 'code · name · pinyin · or paste ["…","…"]';
  const autoFocus = props.autoFocus ?? false;
  const variant = props.variant ?? 'cyber';

  // Batch mode is gated on the consumer wiring `onBatchPick`. Always
  // fetch the full universe so matching can dispatch by entry shape
  // (A / HK / US) regardless of `marketFilter`.
  const fullUniverse = useStockUniverse();
  const batchEntries = useMemo(
    () => (props.onBatchPick === undefined ? null : tryParseBatchInput(s.text)),
    [s.text, props.onBatchPick],
  );
  const batchResult = useMemo<BatchMatchResult | null>(
    () => (batchEntries === null ? null : matchBatch(batchEntries, fullUniverse.data)),
    [batchEntries, fullUniverse.data],
  );

  const onChange = (text: string): void => {
    s.setText(text);
    s.setOpen(true);
    s.setHighlight(0);
    // Notify the host (e.g. All-sector filter wrapper) on every
    // keystroke so it can apply the filter live. Commit-style picks
    // still go through `onPick` separately.
    props.onTextChange?.(text);
  };
  const onOpen = (): void => {
    s.setOpen(true);
  };

  const onApplyBatch = (): void => {
    if (props.onBatchPick === undefined) return;
    if (batchResult === null || batchResult.kind !== 'matched') return;
    props.onBatchPick(batchResult.items);
    s.setText('');
    s.setOpen(false);
  };

  const inBatchMode = batchEntries !== null;

  return (
    <Box position="relative" ref={anchorRef}>
      {variant === 'cyber' ? (
        <CyberInput
          text={s.text}
          onChange={onChange}
          onOpen={onOpen}
          onBlurDeferred={s.onBlurDeferred}
          onKey={s.onKey}
          placeholder={placeholder}
          autoFocus={autoFocus}
        />
      ) : (
        <PlainInput
          text={s.text}
          onChange={onChange}
          onOpen={onOpen}
          onBlurDeferred={s.onBlurDeferred}
          onKey={s.onKey}
          placeholder={placeholder}
          autoFocus={autoFocus}
        />
      )}
      {inBatchMode && batchResult !== null ? (
        <BatchPanel result={batchResult} loading={fullUniverse.isLoading} onApply={onApplyBatch} />
      ) : props.hideDropdown === true ? null : (
        <SearchDropdown
          ref={s.dropdownRef}
          open={s.open && s.text.trim().length > 0}
          matches={s.matches}
          highlight={s.highlight}
          showMarketCol={props.marketFilter === undefined}
          anchorRef={anchorRef}
          onPick={s.commit}
          onHover={s.setHighlight}
        />
      )}
    </Box>
  );
}

interface InputProps {
  readonly text: string;
  readonly onChange: (s: string) => void;
  readonly onOpen: () => void;
  readonly onBlurDeferred: () => void;
  readonly onKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  readonly placeholder: string;
  readonly autoFocus: boolean;
}

const CYBER_INPUT_STYLE = {
  variant: 'outline' as const,
  border: '0',
  h: 'auto',
  minH: 'auto',
  p: 0,
  bg: 'transparent',
  color: 'term.ink',
  fontFamily: 'mono' as const,
  fontSize: '13px',
  letterSpacing: '0.04em',
  outline: 'none',
  outlineColor: 'transparent',
  outlineOffset: 0,
} as const;

function CyberInput(p: InputProps): React.ReactElement {
  return (
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
      <Text color="term.green" fontFamily="mono" fontSize="sm" fontWeight="600" zIndex={1}>
        &gt;
      </Text>
      <Input
        {...CYBER_INPUT_STYLE}
        placeholder={p.placeholder}
        value={p.text}
        autoFocus={p.autoFocus}
        onChange={(e): void => {
          p.onChange(e.target.value);
        }}
        onFocus={p.onOpen}
        onBlur={p.onBlurDeferred}
        onKeyDown={p.onKey}
        zIndex={1}
        css={{ outline: 'none' }}
        _focus={{ boxShadow: 'none', outline: 'none' }}
        _focusVisible={{ boxShadow: 'none', outline: 'none' }}
      />
      <Text className="blink" color="term.green" fontWeight="700" fontFamily="mono" zIndex={1}>
        ▌
      </Text>
    </Flex>
  );
}

function PlainInput(p: InputProps): React.ReactElement {
  return (
    <Input
      bg="term.bg"
      borderColor="term.line"
      color="term.ink"
      fontFamily="mono"
      fontSize="sm"
      h="26px"
      px="8px"
      placeholder={p.placeholder}
      value={p.text}
      autoFocus={p.autoFocus}
      onChange={(e): void => {
        p.onChange(e.target.value);
      }}
      onFocus={p.onOpen}
      onBlur={p.onBlurDeferred}
      onKeyDown={p.onKey}
    />
  );
}

function searchUniverse(
  rows: readonly UniverseStock[],
  query: string,
  cap: number,
): readonly UniverseStock[] {
  const term = query.trim().toLowerCase();
  if (term === '') return [];
  const out: UniverseStock[] = [];
  for (const r of rows) {
    // `includes` (not `startsWith`) so US tickers like "105.AAPL" match
    // both the akshare prefix ("105.") and the bare symbol ("AAPL").
    if (
      r.code.toLowerCase().includes(term) ||
      r.name.toLowerCase().includes(term) ||
      (r.pinyin !== '' && r.pinyin.toLowerCase().includes(term))
    ) {
      out.push(r);
      if (out.length >= cap) break;
    }
  }
  return out;
}
