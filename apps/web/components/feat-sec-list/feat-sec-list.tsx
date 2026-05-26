'use client';

import { Flex, Text } from '@chakra-ui/react';
import { useMemo } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { publishSector } from '../../lib/api/sectors.js';
import { useBlacklistSet } from '../../lib/hooks/use-blacklist.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';
import { useCurrentUserId } from '../../lib/hooks/use-current-user.js';
import { useKlineBulk } from '../../lib/hooks/use-eqty-data.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { useCommand } from '../../lib/ui-cmd/hooks/use-command.js';
import { useFeatHotkeys } from '../../lib/ui-cmd/hooks/use-feat-hotkeys.js';
import { useFocusStore } from '../../lib/ui-cmd/store/focus.js';
import { FeatView } from '../feat-view/feat-view.js';
import { MonoButton } from '../ui/mono-button.js';
import { SectorSwiper } from './sector-swiper.js';

/**
 * Cap on members per analyze_many call. Each member fans out into a
 * web-search + LLM aggregator pass; >50 routinely runs into provider
 * rate-limits and burns minutes of paid LLM time. Surfaces in the
 * AI.SEC sentiment FETCH guard.
 */
export const ANALYZE_MAX_CODES = 50;

/**
 * SEC.LIST — single-row sector slider.
 *
 * Each sector renders as a chip (`name + chg%`); dynamic sectors get a
 * leading `[D]` badge so the kind is legible at a glance. Click to
 * activate; the right-most slot keeps the "new sector" button and a
 * dedicated delete button appears on hover for user/dynamic chips. The
 * sector count is small and bounded (~ tens at most), so a virtualized
 * list would be premature here — `SectorSwiper` covers the swiper-style
 * drag / snap / nav-button affordances natively.
 */
interface FeatSecListProps {
  /** Hosted inside MKT — render content only, no FeatView chrome and no
   *  pane-level "new sector" right slot (the parent owns those). */
  readonly bare?: boolean;
}

export function FeatSecList({ bare }: FeatSecListProps = {}): React.ReactElement {
  const sectors = useSectorsStore((s) => s.sectors);
  const removeSector = useSectorsStore((s) => s.remove);
  const upsertSector = useSectorsStore((s) => s.upsert);
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const setActiveSector = useUiStore((s) => s.setActiveSector);
  const universe = useStockList();
  const currentUserId = useCurrentUserId();
  const { guard, comp: confirmComp } = useConfirm();

  const onDelete = (sector: Sector): void => {
    guard({
      title: 'delete sector',
      message: (
        <>
          <Text fontFamily="mono" fontSize="sm" color="ink2" lineHeight="1.7">
            delete sector{' '}
            <Text as="span" color="accent">
              {sector.name}
            </Text>
            ?
          </Text>
          <Text fontFamily="mono" fontSize="xs" color="ink3" mt="8px">
            // {String(sector.codes.length)} member(s) · this can&apos;t be undone
          </Text>
        </>
      ),
      confirmLabel: 'DELETE',
    })
      .then(() => {
        removeSector(sector.id);
        if (activeSectorId === sector.id) setActiveSector(ALL_SECTOR_ID);
      })
      .catch((e: unknown) => {
        if (e instanceof ConfirmCancelled) return;
        throw e;
      });
  };

  const onTogglePublish = (sector: Sector): void => {
    const verb = sector.published ? 'unpublish' : 'publish';
    guard({
      title: `${verb} sector`,
      message: (
        <>
          <Text fontFamily="mono" fontSize="sm" color="ink2" lineHeight="1.7">
            {verb}{' '}
            <Text as="span" color="accent">
              {sector.name}
            </Text>
            ?
          </Text>
          <Text fontFamily="mono" fontSize="xs" color="ink3" mt="8px">
            //{' '}
            {sector.published
              ? 'other users will no longer see this sector'
              : 'other users will be able to see (but not edit) this sector'}
          </Text>
        </>
      ),
      confirmLabel: verb.toUpperCase(),
    })
      .then(async () => {
        const updated = await publishSector(sector.id, !sector.published);
        upsertSector(updated);
      })
      .catch((e: unknown) => {
        if (e instanceof ConfirmCancelled) return;
        throw e;
      });
  };

  const blacklistSet = useBlacklistSet();
  const allCodes = (universe.data ?? []).map((s) => s.code).filter((c) => !blacklistSet.has(c));
  const allSector: Sector = {
    id: ALL_SECTOR_ID,
    name: 'All',
    kind: 'user',
    market: 'a',
    count: allCodes.length,
    meta: 'every stock',
    chgPct: null,
    codes: allCodes,
    createdBy: 'system',
    published: true,
  };

  // Bulk last-2-bar fetch — same path as the old vertical SEC.LIST: ask
  // for the universe (`codes=[]`) once and let every chip read its
  // members' average chg% from the local map.
  const klineBatch = useKlineBulk([], 2, { enabled: true });
  const chgPctByCode = useMemo(() => {
    const out = new Map<string, number>();
    for (const [code, bars] of klineBatch.byCode) {
      if (bars.length < 2) continue;
      const cur = bars[bars.length - 1]!;
      const prev = bars[bars.length - 2]!;
      if (prev.close === 0) continue;
      out.set(code, cur.close / prev.close - 1);
    }
    return out;
  }, [klineBatch.byCode]);

  const userRows = sectors.filter((r) => r.kind === 'user');
  const dynRows = sectors.filter((r) => r.kind === 'dynamic');
  const orderedSectors: readonly Sector[] = [allSector, ...userRows, ...dynRows];

  // `D` (shift+d) — keyboard-equivalent of the sector chip's delete
  // button. Scoped to MKT so it fires only while the workbench's
  // market pane is the active Feat. Reuses the same confirm guard the
  // mouse path uses, satisfying CLAUDE.md §10.5 "mouse and keyboard
  // must produce the same action via the same dispatch path".
  // Shared dispatch path for keyboard AND chip icon-button clicks.
  // `args.id` (when present, from the chip click) targets that specific
  // sector; absent (keyboard `D`/`P`) falls back to activeSectorId.
  // Per CLAUDE.md §10.5, mouse and keyboard must run through the same
  // command handler — closing this loop is the point of the refactor.
  useFeatHotkeys(Feat.Mkt, {
    'sector.rm': (args) => {
      const id = (args as { id?: string } | undefined)?.id ?? activeSectorId;
      const target = sectors.find((r) => r.id === id);
      if (target === undefined) return;
      if (target.id === ALL_SECTOR_ID) return;
      if (currentUserId === null || target.createdBy !== currentUserId) return;
      onDelete(target);
    },
    'sector.publish': (args) => {
      const id = (args as { id?: string } | undefined)?.id ?? activeSectorId;
      const target = sectors.find((r) => r.id === id);
      if (target === undefined) return;
      if (target.id === ALL_SECTOR_ID) return;
      if (currentUserId === null || target.createdBy !== currentUserId) return;
      onTogglePublish(target);
    },
  });

  // useCommand dispatchers — same registry hops mouse → keyboard.
  const dispatchRm = useCommand('sector.rm');
  const dispatchPublish = useCommand('sector.publish');

  // The "+ new sector" trigger lives in the parent MKT pane's
  // FeatView header (parent owns the dialog state); this component
  // only renders the chip swiper itself.
  return (
    <FeatView feat={Feat.Mkt} bare={bare ?? false} contentSized>
      <SectorSwiper height={40}>
        {orderedSectors.map((s) => {
          const isOwner = currentUserId !== null && s.createdBy === currentUserId;
          const ownerActions = s.id === ALL_SECTOR_ID || !isOwner;
          return (
            <SectorChip
              key={s.id}
              sector={s}
              selected={activeSectorId === s.id}
              chgPctByCode={chgPctByCode}
              onClick={(): void => {
                setActiveSector(s.id);
                useFocusStore.getState().setActive(Feat.Mkt);
              }}
              onDelete={
                ownerActions
                  ? undefined
                  : (): void => {
                      void dispatchRm({ id: s.id });
                    }
              }
              onTogglePublish={
                ownerActions
                  ? undefined
                  : (): void => {
                      void dispatchPublish({ id: s.id });
                    }
              }
            />
          );
        })}
      </SectorSwiper>
      {confirmComp}
    </FeatView>
  );
}

interface ChipProps {
  readonly sector: Sector;
  readonly selected: boolean;
  readonly chgPctByCode: ReadonlyMap<string, number>;
  readonly onClick: () => void;
  readonly onDelete?: (() => void) | undefined;
  readonly onTogglePublish?: (() => void) | undefined;
}

function SectorChip({
  sector,
  selected,
  chgPctByCode,
  onClick,
  onDelete,
  onTogglePublish,
}: ChipProps): React.ReactElement {
  const isDynamic = sector.kind === 'dynamic';
  const codes = sector.codes;
  const avgChgPct = (() => {
    let sum = 0;
    let count = 0;
    for (const c of codes) {
      const v = chgPctByCode.get(c);
      if (v === undefined) continue;
      sum += v;
      count += 1;
    }
    return count === 0 ? null : sum / count;
  })();

  // Two-row chip: sector name (compact) on top, pct underneath. The
  // vertical layout cuts the chip's horizontal footprint roughly in
  // half compared with the previous one-row design (name + pct + gaps
  // shared a single line), so more sectors fit inside the same swiper
  // viewport. Padding shrinks slightly to compensate for the added
  // height — net pane height is unchanged.
  return (
    <Flex
      as="li"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`select sector ${sector.name}`}
      onClick={onClick}
      onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>): void => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      direction="column"
      align="flex-start"
      justify="center"
      gap="1px"
      px="8px"
      py="4px"
      borderRightWidth="1px"
      borderColor="line"
      bg={selected ? 'accentBg' : 'panel'}
      borderTopWidth={selected ? '2px' : 0}
      borderTopColor="accent"
      cursor="pointer"
      _hover={selected ? {} : { bg: 'hover' }}
      _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '-2px' }}
      flexShrink={0}
      whiteSpace="nowrap"
      data-testid={`sector-chip-${sector.id}`}
    >
      <Flex align="center" gap="4px" w="100%">
        {isDynamic && (
          <Text
            fontFamily="mono"
            fontSize="xs"
            fontWeight="700"
            letterSpacing="0.14em"
            color="link"
            aria-label="dynamic sector"
          >
            [D]
          </Text>
        )}
        {sector.published === true && (
          <Text
            fontFamily="mono"
            fontSize="xs"
            fontWeight="700"
            letterSpacing="0.14em"
            color="accent"
            aria-label="published sector"
          >
            [PUB]
          </Text>
        )}
        <Text
          fontFamily="mono"
          fontSize="xs"
          color={selected ? 'ink' : 'ink2'}
          fontWeight={selected ? '700' : '500'}
          letterSpacing="0.04em"
        >
          {sector.name}
        </Text>
        {onTogglePublish !== undefined && (
          <MonoButton
            icon="upload"
            label={`${sector.published ? 'unpublish' : 'publish'} sector ${sector.name}`}
            onClick={(e: React.MouseEvent<HTMLButtonElement>): void => {
              e.stopPropagation();
              onTogglePublish();
            }}
          />
        )}
        {onDelete !== undefined && (
          <MonoButton
            icon="delete"
            label={`delete sector ${sector.name}`}
            onClick={(e: React.MouseEvent<HTMLButtonElement>): void => {
              e.stopPropagation();
              onDelete();
            }}
          />
        )}
      </Flex>
      {avgChgPct !== null ? (
        <Text fontFamily="mono" fontSize="xs" color={avgChgPct >= 0 ? 'up' : 'down'}>
          {avgChgPct >= 0 ? '+' : ''}
          {(avgChgPct * 100).toFixed(2)}%
        </Text>
      ) : (
        <Text fontFamily="mono" fontSize="xs" color="ink3">
          —
        </Text>
      )}
    </Flex>
  );
}
