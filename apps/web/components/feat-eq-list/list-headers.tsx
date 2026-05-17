'use client';

/**
 * Header bars + editable title used by EQ.LIST. Split into a sibling
 * file so `feat-eq-list.tsx` stays under the 400-line ceiling and so
 * each header is independently readable / testable.
 *
 * - {@link EditableTitle} — inline-edit pane title (sector rename).
 * - {@link FilterHeader} — text filter input + match counter.
 * - {@link UserSectorHeader} — code-search picker for user sectors.
 * - {@link DynamicHeader} — wraps FeatScrDsl with the refresh bar.
 * - {@link DynamicRefreshBar} — "last screened: …" + refresh button.
 */

import { Box, Flex, Input, Text } from '@chakra-ui/react';
import { useEffect, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { formatRelativeTime } from '../../lib/fp/eq-list-fp.js';
import { refreshSector } from '../../lib/api/sectors.js';
import { useLayoutStore } from '../../lib/stores/layout.store.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { FeatBtEval } from '../feat-bt-eval/feat-bt-eval.js';
import { FeatScrDsl } from '../feat-scr-dsl/feat-scr-dsl.js';
import { FeatScrNl } from '../feat-scr-nl/feat-scr-nl.js';
import { MonoButton } from '../ui/mono-button.js';

interface EditableTitleProps {
  readonly value: string;
  readonly editable: boolean;
  readonly onSave: (next: string) => void;
}

export function EditableTitle({ value, editable, onSave }: EditableTitleProps): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  if (editing) {
    const commit = (): void => {
      onSave(draft);
      setEditing(false);
    };
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e): void => {
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e): void => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        h="20px"
        w="160px"
        bg="panel"
        borderWidth="1px"
        borderColor="accent"
        borderRadius="0"
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.12em"
        px="6px"
        textTransform="uppercase"
      />
    );
  }
  return (
    <Text
      fontFamily="mono"
      fontSize="10px"
      letterSpacing="0.18em"
      textTransform="uppercase"
      fontWeight="600"
      color="ink2"
      whiteSpace="nowrap"
      overflow="hidden"
      textOverflow="ellipsis"
      cursor={editable ? 'text' : 'default'}
      _hover={editable ? { color: 'accent' } : {}}
      onClick={(): void => {
        if (editable) setEditing(true);
      }}
      title={editable ? 'click to rename' : undefined}
    >
      {value}
    </Text>
  );
}

interface FilterHeaderProps {
  readonly filter: string;
  readonly setFilter: (v: string) => void;
  readonly total: number;
  readonly hits: number;
}

export function FilterHeader({
  filter,
  setFilter,
  total,
  hits,
}: FilterHeaderProps): React.ReactElement {
  return (
    <Flex
      align="center"
      gap="10px"
      px="14px"
      py="8px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
      flexShrink={0}
    >
      <Text color="prompt" fontFamily="mono" fontSize="12px" fontWeight="700">
        $
      </Text>
      <Input
        value={filter}
        onChange={(e): void => {
          setFilter(e.target.value);
        }}
        placeholder="filter --code|name"
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

interface UserSectorHeaderProps {
  readonly sector: Sector;
  readonly onAdd: (code: string) => void;
  readonly onBatchAdd: (codes: readonly string[]) => void;
}

export function UserSectorHeader({ onAdd, onBatchAdd }: UserSectorHeaderProps): React.ReactElement {
  return (
    <Box flexShrink={0}>
      <FeatScrNl
        marketFilter="a"
        onPick={(s): void => {
          onAdd(s.code);
        }}
        onBatchPick={(stocks): void => {
          onBatchAdd(stocks.map((s) => s.code));
        }}
      />
    </Box>
  );
}

export function DynamicHeader({ sector }: { sector: Sector }): React.ReactElement {
  // FeatScrDsl is wrapped in FeatView; we mirror its persisted mode so
  // the host wrapper collapses to header-height when minimized and
  // expands to a definite 320 px when restored. A definite height when
  // restored is required because FeatView body's flex chain otherwise
  // resolves to 0 px in an indefinite parent — that prevents the
  // body's internal scroll from engaging on long plans.
  const mode = useLayoutStore((s) => s.featViewMode[Feat.ScreenDsl]);
  const isMinimized = mode === 'minimized';
  const btMode = useLayoutStore((s) => s.featViewMode[Feat.BtEval]);
  // BT.EVAL defaults to minimized (see FEAT_CONFIG_MAP); only allocate
  // body height when the user has restored it. Tall enough to fit the
  // box plot + summary table without an inner scroll on first render.
  const btIsMinimized = btMode !== 'normal';
  return (
    <>
      <DynamicRefreshBar sector={sector} />
      <Box
        h={isMinimized ? 'auto' : '320px'}
        display="flex"
        flexDirection="column"
        minH={0}
        flexShrink={0}
      >
        <FeatScrDsl />
      </Box>
      <Box
        h={btIsMinimized ? 'auto' : '360px'}
        display="flex"
        flexDirection="column"
        minH={0}
        flexShrink={0}
      >
        <FeatBtEval />
      </Box>
    </>
  );
}

function DynamicRefreshBar({ sector }: { sector: Sector }): React.ReactElement {
  const upsert = useSectorsStore((s) => s.upsert);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canRefresh = sector.screenPlan !== undefined;
  const onRefresh = (): void => {
    if (!canRefresh || pending) return;
    setPending(true);
    setError(null);
    refreshSector(sector.id)
      .then((next) => {
        upsert(next);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <Flex
      align="center"
      gap="10px"
      px="14px"
      py="6px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
      flexShrink={0}
    >
      <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.14em">
        {/* eslint-disable-next-line no-restricted-globals -- relative-time
            display ticks on render; pulling a Clock through props for a
            cosmetic "Nm ago" label isn't worth the plumbing. */}
        last screened: {formatRelativeTime(sector.lastScreenedAt, Date.now())}
      </Text>
      <Box flex="1" />
      {error !== null && (
        <Text fontFamily="mono" fontSize="10px" color="down" letterSpacing="0.06em">
          {error}
        </Text>
      )}
      <MonoButton
        icon="refresh"
        label={canRefresh ? (pending ? 'refreshing…' : 'refresh') : 'no plan to re-run'}
        onClick={onRefresh}
        disabled={!canRefresh || pending}
      />
    </Flex>
  );
}
