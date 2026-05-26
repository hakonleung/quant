'use client';

import { Box, Flex, Text } from '@chakra-ui/react';
import type { EnrichedLedgerEntry } from '@quant/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Decimal } from 'decimal.js';
import { useRef } from 'react';

import { useContainerWidth } from '../../lib/hooks/use-container-width.js';
import { MonoButton } from '../ui/mono-button.js';

interface LedgerListProps {
  readonly enriched: readonly EnrichedLedgerEntry[];
  readonly onEdit: (date: string) => void;
  readonly onDelete: (date: string) => void;
  readonly busy: boolean;
}

const ROW_H = 32;

/**
 * Width tier consumed by every cell in the row. `narrow` (< 360 px host)
 * is what the right column hits at its `rightMin = 280 px` floor — five
 * columns simply don't fit, so we drop CASHFLOW + PCT + CLOSING. The
 * mid tier (360–520 px) brings PCT and CLOSING back; CASHFLOW only
 * appears at ≥ 520 px because users routinely confuse "implicit cash
 * flow" with their entered fields and we don't want to surface it
 * unless the host actually has space for the `~` derived marker too.
 */
type WidthTier = 'narrow' | 'mid' | 'wide';

function widthTier(hostWidth: number): WidthTier {
  if (hostWidth === 0) return 'wide'; // SSR / pre-measure: render the generous layout
  if (hostWidth < 360) return 'narrow';
  if (hostWidth < 520) return 'mid';
  return 'wide';
}

export function LedgerList({
  enriched,
  onEdit,
  onDelete,
  busy,
}: LedgerListProps): React.ReactElement {
  const { ref: hostRef, width: hostWidth } = useContainerWidth();
  const tier = widthTier(hostWidth);
  if (enriched.length === 0) return <EmptyState hostRef={hostRef} />;
  // Newest first in the list view; underlying enriched is asc by date.
  const rows = [...enriched].reverse();
  return (
    <Box ref={hostRef} flex="1" minH={0} display="flex" flexDirection="column">
      <Header tier={tier} />
      <RowsBody rows={rows} tier={tier} onEdit={onEdit} onDelete={onDelete} busy={busy} />
    </Box>
  );
}

function EmptyState({
  hostRef,
}: {
  readonly hostRef: React.RefObject<HTMLDivElement>;
}): React.ReactElement {
  return (
    <Flex ref={hostRef} flex="1" align="center" justify="center" minH="120px">
      <Text fontSize="xs" color="term.ink3" fontFamily="mono">
        暂无记录
      </Text>
    </Flex>
  );
}

interface RowsBodyProps {
  readonly rows: readonly EnrichedLedgerEntry[];
  readonly tier: WidthTier;
  readonly onEdit: (date: string) => void;
  readonly onDelete: (date: string) => void;
  readonly busy: boolean;
}

function RowsBody({ rows, tier, onEdit, onDelete, busy }: RowsBodyProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });
  return (
    <Box
      ref={scrollRef}
      flex="1"
      minH={0}
      overflowY="auto"
      position="relative"
      fontFamily="mono"
      fontSize="xs"
    >
      <Box position="relative" style={{ height: `${String(virtualizer.getTotalSize())}px` }}>
        {virtualizer.getVirtualItems().map((vRow) => {
          const entry = rows[vRow.index];
          if (entry === undefined) return null;
          return (
            <Row
              key={entry.date}
              entry={entry}
              top={vRow.start}
              height={vRow.size}
              tier={tier}
              onEdit={onEdit}
              onDelete={onDelete}
              busy={busy}
            />
          );
        })}
      </Box>
    </Box>
  );
}

interface HeaderProps {
  readonly tier: WidthTier;
}

function Header({ tier }: HeaderProps): React.ReactElement {
  return (
    <Flex
      borderBottomWidth="1px"
      borderColor="term.line"
      px="10px"
      py="4px"
      gap="12px"
      fontFamily="mono"
      fontSize="xs"
      letterSpacing="0.12em"
      color="term.ink3"
      flexShrink={0}
    >
      <HeaderCell w="84px">DATE</HeaderCell>
      <HeaderCell w="92px" align="right">
        PNL
      </HeaderCell>
      {tier !== 'narrow' && (
        <HeaderCell w="56px" align="right">
          PCT
        </HeaderCell>
      )}
      {tier !== 'narrow' && (
        <HeaderCell w="100px" align="right">
          CLOSING
        </HeaderCell>
      )}
      {/* CASHFLOW = the implicit inflow / outflow the row encodes (the
       *  "入金" the user wanted surfaced). Showing at every tier — at
       *  narrow we keep just DATE / PNL / CASHFLOW / OPS so users on a
       *  shrunk-down right column still see deposits. */}
      <HeaderCell w="80px" align="right">
        CASHFLOW
      </HeaderCell>
      <Box flex="1" />
      <HeaderCell w="56px" align="right">
        OPS
      </HeaderCell>
    </Flex>
  );
}

interface HeaderCellProps {
  readonly w: string;
  readonly align?: 'left' | 'right';
  readonly children: React.ReactNode;
}

function HeaderCell({ w, align = 'left', children }: HeaderCellProps): React.ReactElement {
  return (
    <Box w={w} textAlign={align} flexShrink={0}>
      {children}
    </Box>
  );
}

interface RowProps {
  readonly entry: EnrichedLedgerEntry;
  readonly top: number;
  readonly height: number;
  readonly tier: WidthTier;
  readonly onEdit: (date: string) => void;
  readonly onDelete: (date: string) => void;
  readonly busy: boolean;
}

function Row({ entry, top, height, tier, onEdit, onDelete, busy }: RowProps): React.ReactElement {
  const pnlD = new Decimal(entry.pnlAmount);
  // 涨红跌绿: positive PnL → up (red), negative → down (green).
  // LDG renders inside the cyber USR pane — neutral PnL must use
  // `term.ink`; plain `ink` resolves to near-black on the term panel.
  const pnlTone =
    pnlD.isPositive() && !pnlD.isZero() ? 'up' : pnlD.isNegative() ? 'down' : 'term.ink';
  return (
    <Flex
      position="absolute"
      top="0"
      left="0"
      right="0"
      style={{ transform: `translateY(${String(top)}px)`, height: `${String(height)}px` }}
      align="center"
      px="10px"
      gap="12px"
      borderBottomWidth="1px"
      borderColor="term.line"
      color="term.ink"
      _hover={{ bg: 'term.bgElev' }}
    >
      <Box w="84px" flexShrink={0}>
        {entry.date}
      </Box>
      <Box w="92px" textAlign="right" color={pnlTone} flexShrink={0}>
        {pnlD.toFixed(2)}
      </Box>
      <OptionalCells entry={entry} tier={tier} pctTone={pnlTone} />
      <Box flex="1" />
      <RowOps entry={entry} busy={busy} onEdit={onEdit} onDelete={onDelete} />
    </Flex>
  );
}

interface OptionalCellsProps {
  readonly entry: EnrichedLedgerEntry;
  readonly tier: WidthTier;
  readonly pctTone: string;
}

function OptionalCells({ entry, tier, pctTone }: OptionalCellsProps): React.ReactElement {
  const cashFlow = new Decimal(entry.cashFlow);
  const cashFlowDisplay = cashFlow.isZero() ? '—' : cashFlow.toFixed(2);
  // Inflow (deposit / 入金) reads red; outflow (withdraw) green — same
  // 涨红跌绿 convention as PNL. Zero stays neutral.
  const cashFlowTone =
    cashFlow.isPositive() && !cashFlow.isZero()
      ? 'up'
      : cashFlow.isNegative()
        ? 'down'
        : 'term.ink3';
  const cashFlowCell = (
    <Flex w="80px" justify="flex-end" align="center" gap="4px" flexShrink={0} color={cashFlowTone}>
      <Text fontSize="xs">{cashFlowDisplay}</Text>
      {/* CASHFLOW is a derived field. `~` mirrors CLOSING. */}
      {!cashFlow.isZero() && <DerivedBadge title="派生字段：Δclosing − pnlAmount" />}
    </Flex>
  );
  if (tier === 'narrow') return cashFlowCell;
  return (
    <>
      <Box w="56px" textAlign="right" color={pctTone} flexShrink={0}>
        {new Decimal(entry.derivedDailyPct).toFixed(2)}%
      </Box>
      <Flex w="100px" justify="flex-end" align="center" gap="4px" flexShrink={0}>
        <Text fontSize="xs">{new Decimal(entry.derivedClosingPosition).toFixed(2)}</Text>
        {!entry.closingProvided && <DerivedBadge title="链式推导值" />}
      </Flex>
      {cashFlowCell}
    </>
  );
}

interface RowOpsProps {
  readonly entry: EnrichedLedgerEntry;
  readonly busy: boolean;
  readonly onEdit: (date: string) => void;
  readonly onDelete: (date: string) => void;
}

function RowOps({ entry, busy, onEdit, onDelete }: RowOpsProps): React.ReactElement {
  return (
    <Flex gap="2px" flexShrink={0}>
      <MonoButton
        icon="edit"
        label={`edit ${entry.date}`}
        disabled={busy}
        onClick={(): void => {
          onEdit(entry.date);
        }}
      />
      <MonoButton
        icon="delete"
        label={`delete ${entry.date}`}
        disabled={busy}
        onClick={(): void => {
          onDelete(entry.date);
        }}
      />
    </Flex>
  );
}

function DerivedBadge({ title }: { readonly title: string }): React.ReactElement {
  return (
    <Text
      as="span"
      fontSize="xs"
      color="term.ink3"
      letterSpacing="0.1em"
      border="1px dashed"
      borderColor="term.line"
      px="2px"
      title={title}
      aria-label={title}
    >
      ~
    </Text>
  );
}
