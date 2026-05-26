'use client';

/**
 * Virtualised scrollable grid + sticky column header + memoised row
 * for EQ.LIST. Pulled out of `feat-eq-list.tsx` so the orchestrator
 * stays under the 400-line ceiling.
 *
 * Architecture:
 *   - {@link ScrollGrid} — owns the scroll container, virtualizer,
 *     keyboard navigation. Holds two refs (`onRowClickRef`,
 *     `onRowRemoveRef`, `rowsRef`) so the per-row handlers passed to
 *     {@link RowItem} are reference-stable and `React.memo` actually
 *     bails out for rows whose props didn't really change.
 *   - {@link ColumnHeader} — sticky header row with click-to-sort.
 *   - {@link RowItem} — wrapped in `memo` so a focus change re-renders
 *     just the previous + new focused rows, not every visible cell.
 */

import { Box, Text } from '@chakra-ui/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import type { ListRow } from '../../lib/fp/eq-list-fp.js';
import { MonoButton } from '../ui/mono-button.js';

import { DELETE_COL_W, ROW_H, type ColumnDef, type SortState } from './list-types.js';

interface ScrollGridProps {
  readonly columns: readonly ColumnDef[];
  readonly rows: readonly ListRow[];
  readonly sort: SortState | null;
  readonly setSort: (s: SortState | null) => void;
  readonly focusedCode: string | null;
  readonly onRowClick: (row: ListRow) => void;
  readonly onRowRemove: ((code: string) => void) | null;
  readonly emptyHint: string;
}

export function ScrollGrid({
  columns,
  rows,
  sort,
  setSort,
  focusedCode,
  onRowClick,
  onRowRemove,
  emptyHint,
}: ScrollGridProps): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerH, setHeaderH] = useState(0);
  const removable = onRowRemove !== null;

  // The column header sits inside the scroll container as a `position:
  // sticky` row, so it occupies the top of the scrollElement's content
  // box. The virtualizer needs to know that offset — otherwise its
  // scrollToIndex math is off by headerH and ArrowDown can land focus
  // one row past the visible bottom (hidden out of view).
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (el === null) return;
    setHeaderH(el.offsetHeight);
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e === undefined) return;
      setHeaderH(e.contentRect.height);
    });
    ro.observe(el);
    return (): void => {
      ro.disconnect();
    };
  }, []);
  const totalWidth = columns.reduce((acc, c) => acc + c.w, 0) + (removable ? DELETE_COL_W : 0);

  // Stable row-level handlers so RowItem's React.memo can bail out for
  // rows whose props didn't actually change (focus moves between two
  // rows, sort flips, column resize). The closures below capture
  // current props through refs so we don't need them in the
  // dependency list.
  const onRowClickRef = useRef(onRowClick);
  const onRowRemoveRef = useRef(onRowRemove);
  onRowClickRef.current = onRowClick;
  onRowRemoveRef.current = onRowRemove;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onSelectByCode = useCallback((code: string): void => {
    const row = rowsRef.current.find((r) => r.code === code);
    if (row !== undefined) {
      onRowClickRef.current(row);
      scrollRef.current?.focus({ preventScroll: true });
    }
  }, []);
  const onRemoveByCode = useCallback((code: string): void => {
    onRowRemoveRef.current?.(code);
  }, []);
  const removeHandler = removable ? onRemoveByCode : null;

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    scrollMargin: headerH,
  });

  // Cache the row index for the currently-focused code so the keyboard
  // handler can step ±1 in O(1). `-1` means "no focus yet" — the first
  // arrow press lands on row 0.
  const focusedIndex = useMemo(() => {
    if (focusedCode === null) return -1;
    return rows.findIndex((r) => r.code === focusedCode);
  }, [rows, focusedCode]);

  // Scroll a row index into view, respecting the sticky `ColumnHeader`
  // that overlays the top `headerH` pixels of the visible area. The
  // virtualizer's own `scrollToIndex` doesn't fully account for that
  // overlay (its `scrollMargin` shifts item positions but the visible
  // window it compares against is still the raw `clientHeight`), so a
  // bottom-align lands the row `headerH` below the visible bottom —
  // visually one row past the list, hidden out of view.
  const scrollRowIntoView = useCallback(
    (idx: number): void => {
      const el = scrollRef.current;
      if (el === null) return;
      const rowTop = headerH + idx * ROW_H;
      const rowBottom = rowTop + ROW_H;
      const visibleTop = el.scrollTop + headerH;
      const visibleBottom = el.scrollTop + el.clientHeight;
      if (rowTop < visibleTop) {
        el.scrollTo({ top: rowTop - headerH });
      } else if (rowBottom > visibleBottom) {
        el.scrollTo({ top: rowBottom - el.clientHeight });
      }
    },
    [headerH],
  );

  // External focus changes (J/K hotkeys from the ui-cmd engine mutate
  // useUiStore.focusCode out-of-band) must auto-scroll the new row into
  // view. The grid's own ArrowDown/Up handler already calls
  // scrollRowIntoView — this mirrors that for the external path.
  useEffect(() => {
    if (focusedIndex < 0) return;
    scrollRowIntoView(focusedIndex);
  }, [focusedIndex, scrollRowIntoView]);

  // After the user clicks a header to re-sort, snap the table back to
  // the top — otherwise the previous scroll position points into the
  // middle of a freshly reordered list, which is disorienting.
  const sortKey = sort === null ? null : `${sort.key}:${sort.dir}`;
  const lastSortKeyRef = useRef<string | null>(sortKey);
  useEffect(() => {
    if (lastSortKeyRef.current === sortKey) return;
    lastSortKeyRef.current = sortKey;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [sortKey]);

  // ArrowUp/Down step focus through the sorted rows when the grid (or
  // any of its descendants) has keyboard focus. PageUp/Down jump 10
  // rows; Home/End snap to the ends. The handler also auto-scrolls
  // the new focus row into view via the virtualizer.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (rows.length === 0) return;
    const cur = focusedIndex < 0 ? -1 : focusedIndex;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        next = cur < 0 ? 0 : Math.min(rows.length - 1, cur + 1);
        break;
      case 'ArrowUp':
        next = cur < 0 ? 0 : Math.max(0, cur - 1);
        break;
      case 'PageDown':
        next = cur < 0 ? 0 : Math.min(rows.length - 1, cur + 10);
        break;
      case 'PageUp':
        next = cur < 0 ? 0 : Math.max(0, cur - 10);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      default:
        return;
    }
    if (next === cur) return;
    e.preventDefault();
    const target = rows[next];
    if (target === undefined) return;
    onRowClick(target);
    scrollRowIntoView(next);
  };

  if (rows.length === 0) {
    return (
      <Box flex="1" overflow="auto" px="14px" py="14px">
        <Text fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.12em">
          // {emptyHint}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      ref={scrollRef}
      flex="1"
      overflow="auto"
      position="relative"
      tabIndex={0}
      role="listbox"
      aria-label="股票列表"
      aria-activedescendant={focusedCode !== null ? `eqlist-row-${focusedCode}` : undefined}
      onKeyDown={onKeyDown}
      _focus={{ outline: 'none' }}
      _focusVisible={{ boxShadow: '0 0 0 1px var(--chakra-colors-accent) inset' }}
    >
      <Box w={`${String(totalWidth)}px`} minW="100%">
        <Box ref={headerRef}>
          <ColumnHeader columns={columns} sort={sort} setSort={setSort} removable={removable} />
        </Box>
        <Box
          position="relative"
          h={`${String(Math.max(0, rowVirtualizer.getTotalSize() - headerH))}px`}
          w={`${String(totalWidth)}px`}
        >
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            if (row === undefined) return null;
            return (
              <RowItem
                key={vi.key}
                row={row}
                rowIndex={vi.index}
                columns={columns}
                top={vi.start - headerH}
                h={vi.size}
                focused={focusedCode !== null && row.code === focusedCode}
                onSelect={onSelectByCode}
                onRemove={removeHandler}
              />
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

interface ColumnHeaderProps {
  readonly columns: readonly ColumnDef[];
  readonly sort: SortState | null;
  readonly setSort: (s: SortState | null) => void;
  readonly removable: boolean;
}

function ColumnHeader({
  columns,
  sort,
  setSort,
  removable,
}: ColumnHeaderProps): React.ReactElement {
  return (
    <Box
      display="flex"
      bg="glass.panelStrong"
      backdropFilter="blur(12px)"
      borderBottomWidth="1px"
      borderColor="line"
      flexShrink={0}
      position="sticky"
      top={0}
      zIndex={3}
    >
      {removable && (
        <Box
          w={`${String(DELETE_COL_W)}px`}
          flexShrink={0}
          position="sticky"
          left={0}
          bg="glass.panelStrong"
          backdropFilter="blur(12px)"
          zIndex={4}
        />
      )}
      {columns.map((c, i) => {
        const sortable = c.sortable !== false;
        const active = sortable && sort?.key === c.key;
        const arrow = !active ? '' : sort.dir === 'asc' ? ' ▲' : ' ▼';
        // Non-sortable columns render as a plain Box so keyboard users
        // don't Tab onto an inert button (a11y MINOR from the Phase 3
        // review). Sortable columns keep their <button> semantics.
        const isInteractive = sortable;
        const onHeaderClick = isInteractive
          ? (): void => {
              if (!active) {
                setSort({ key: c.key, dir: 'asc' });
              } else if (sort.dir === 'asc') {
                setSort({ key: c.key, dir: 'desc' });
              } else {
                setSort(null);
              }
            }
          : undefined;
        return (
          <Box
            {...(isInteractive ? { as: 'button' as const, onClick: onHeaderClick } : {})}
            key={c.key}
            w={`${String(c.w)}px`}
            px={c.w <= 50 ? '2px' : '8px'}
            py="4px"
            textAlign={c.align}
            color={active ? 'accent' : 'ink3'}
            fontFamily="mono"
            fontSize="xs"
            letterSpacing={c.w <= 50 ? '0.04em' : '0.16em'}
            textTransform="uppercase"
            fontWeight="700"
            whiteSpace="normal"
            wordBreak="break-word"
            lineHeight="1.1"
            bg={c.sticky === true ? 'glass.panelStrong' : 'transparent'}
            backdropFilter={c.sticky === true ? 'blur(12px)' : undefined}
            cursor={sortable ? 'pointer' : 'default'}
            _hover={sortable ? { color: 'accent' } : {}}
            position={c.sticky === true ? 'sticky' : 'static'}
            left={
              c.sticky === true ? `${String(stickyLeftFor(columns, i, removable))}px` : undefined
            }
            zIndex={c.sticky === true ? 4 : 3}
            borderColor="line"
            flexShrink={0}
          >
            {c.label}
            {arrow}
          </Box>
        );
      })}
    </Box>
  );
}

interface RowItemProps {
  readonly row: ListRow;
  readonly rowIndex: number;
  readonly columns: readonly ColumnDef[];
  readonly top: number;
  readonly h: number;
  readonly focused: boolean;
  /** Receives `row.code`; the parent looks up the full row from a ref. */
  readonly onSelect: (code: string) => void;
  /** `null` when the active sector isn't user-managed. */
  readonly onRemove: ((code: string) => void) | null;
}

const RowItem = memo(function RowItem({
  row,
  rowIndex,
  columns,
  top,
  h,
  focused,
  onSelect,
  onRemove,
}: RowItemProps): React.ReactElement {
  const hasRemove = onRemove !== null;
  const onClick = (): void => {
    onSelect(row.code);
  };
  return (
    <Box
      // `id` + ScrollGrid's `aria-activedescendant` give screen readers
      // a stable handle on the keyboard-focused row without moving DOM
      // focus off the grid container.
      id={`eqlist-row-${row.code}`}
      position="absolute"
      top={0}
      left={0}
      transform={`translateY(${String(top)}px)`}
      h={`${String(h)}px`}
      display="flex"
      alignItems="center"
      borderBottomWidth="1px"
      borderColor="glass.line"
      borderLeftWidth={focused ? '2px' : 0}
      borderLeftColor="accent"
      // Transparent default — the pane glass shows through every row.
      // Focused row carries a wash + a 2 px accent border so it
      // reads against the grid; hover adds a subtle ink wash so the
      // pointer feedback is visible against the glass canvas.
      bg={focused ? 'accentBg' : 'transparent'}
      cursor="pointer"
      _hover={focused ? {} : { bg: 'hover' }}
      onClick={onClick}
      role="option"
      aria-selected={focused}
    >
      {hasRemove && (
        <Box
          position="sticky"
          left={0}
          h={`${String(h)}px`}
          w={`${String(DELETE_COL_W)}px`}
          display="grid"
          placeItems="center"
          // Sticky delete cell still needs to occlude the rows that
          // scroll under it horizontally — `panelStrong` (70%) blocks
          // text that `panelSoft` (28%) leaked through even with
          // backdrop-blur. Focus accent layered via inset shadow.
          bg="glass.panelStrong"
          backdropFilter="blur(12px)"
          boxShadow={focused ? 'inset 0 0 0 9999px var(--chakra-colors-accentBg)' : undefined}
          zIndex={2}
          flexShrink={0}
        >
          <MonoButton
            icon="delete"
            label={`remove ${row.code}`}
            onClick={(e: React.MouseEvent<HTMLButtonElement>): void => {
              e.stopPropagation();
              onRemove(row.code);
            }}
          />
        </Box>
      )}
      {columns.map((c, i) => (
        <Box
          key={c.key}
          w={`${String(c.w)}px`}
          h={`${String(h)}px`}
          px="8px"
          py="2px"
          textAlign={c.align}
          overflow="hidden"
          display="flex"
          alignItems="center"
          justifyContent={c.align === 'right' ? 'flex-end' : 'flex-start'}
          position={c.sticky === true ? 'sticky' : 'static'}
          left={c.sticky === true ? `${String(stickyLeftFor(columns, i, hasRemove))}px` : undefined}
          // Sticky cells must fully occlude the rows that scroll under
          // them horizontally. `glass.panelSoft` (28% opacity) + blur
          // still let text bleed through; `panelStrong` (70%) blocks
          // it. Focused rows layer the `accentBg` tint via an inset
          // shadow on top so the focus accent still reads.
          bg={c.sticky === true ? 'glass.panelStrong' : 'transparent'}
          backdropFilter={c.sticky === true ? 'blur(12px)' : undefined}
          boxShadow={
            c.sticky === true && focused
              ? 'inset 0 0 0 9999px var(--chakra-colors-accentBg)'
              : undefined
          }
          zIndex={c.sticky === true ? 1 : 0}
          borderBottomWidth={c.sticky === true ? '1px' : 0}
          borderColor="glass.line"
          flexShrink={0}
        >
          {c.render(row, rowIndex)}
        </Box>
      ))}
    </Box>
  );
});

/** Pixel offset for a sticky cell at `i`, summing the delete-column gutter
 *  (when shown) plus the widths of every sticky column before it. */
function stickyLeftFor(columns: readonly ColumnDef[], i: number, hasRemove: boolean): number {
  let left = hasRemove ? DELETE_COL_W : 0;
  for (let j = 0; j < i; j += 1) {
    const col = columns[j];
    if (col !== undefined && col.sticky === true) left += col.w;
  }
  return left;
}
