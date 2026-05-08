'use client';

import { Flex, Text } from '@chakra-ui/react';
import { useMemo, useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useBlacklistSet } from '../../lib/hooks/use-blacklist.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';
import { useKlineBulk } from '../../lib/hooks/use-eqty-data.js';
import { useStockList } from '../../lib/hooks/use-stock-list.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { FeatView } from '../feat-view/feat-view.js';
import { FeatViewHeaderRight } from '../feat-view/feat-view-header.js';
import { MonoButton } from '../ui/mono-button.js';
import { NewSectorDialog } from './new-sector-dialog.js';
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
export function FeatSecList(): React.ReactElement {
  const sectors = useSectorsStore((s) => s.sectors);
  const removeSector = useSectorsStore((s) => s.remove);
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const setActiveSector = useUiStore((s) => s.setActiveSector);
  const universe = useStockList();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { guard, comp: confirmComp } = useConfirm();

  const onDelete = (sector: Sector): void => {
    guard({
      title: 'delete sector',
      message: (
        <>
          <Text fontFamily="mono" fontSize="12px" color="ink2" lineHeight="1.7">
            delete sector{' '}
            <Text as="span" color="accent">
              {sector.name}
            </Text>
            ?
          </Text>
          <Text fontFamily="mono" fontSize="11px" color="ink3" mt="8px">
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

  const blacklistSet = useBlacklistSet();
  const allCodes = (universe.data ?? []).map((s) => s.code).filter((c) => !blacklistSet.has(c));
  const allSector: Sector = {
    id: ALL_SECTOR_ID,
    name: 'All',
    kind: 'user',
    count: allCodes.length,
    meta: 'every stock',
    chgPct: null,
    codes: allCodes,
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

  return (
    <FeatView
      feat={Feat.SectorList}
      contentSized
      right={
        <FeatViewHeaderRight>
          <MonoButton
            icon="add"
            label="new sector"
            onClick={(): void => {
              setDialogOpen(true);
            }}
          />
        </FeatViewHeaderRight>
      }
    >
      <SectorSwiper height={40}>
        {orderedSectors.map((s) => (
          <SectorChip
            key={s.id}
            sector={s}
            selected={activeSectorId === s.id}
            chgPctByCode={chgPctByCode}
            onClick={(): void => {
              setActiveSector(s.id);
            }}
            onDelete={
              s.id === ALL_SECTOR_ID
                ? undefined
                : (): void => {
                    onDelete(s);
                  }
            }
          />
        ))}
      </SectorSwiper>
      <NewSectorDialog
        open={dialogOpen}
        onClose={(): void => {
          setDialogOpen(false);
        }}
      />
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
}

function SectorChip({
  sector,
  selected,
  chgPctByCode,
  onClick,
  onDelete,
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

  return (
    <Flex
      as="li"
      role="button"
      onClick={onClick}
      align="center"
      gap="6px"
      px="10px"
      borderRightWidth="1px"
      borderColor="line2"
      bg={selected ? 'accentBg' : 'panel'}
      borderTopWidth={selected ? '2px' : 0}
      borderTopColor="accent"
      cursor="pointer"
      _hover={selected ? {} : { bg: 'hover' }}
      flexShrink={0}
      whiteSpace="nowrap"
      data-testid={`sector-chip-${sector.id}`}
    >
      {isDynamic && (
        <Text
          fontFamily="mono"
          fontSize="9px"
          fontWeight="700"
          letterSpacing="0.14em"
          color="accent"
          aria-label="dynamic sector"
        >
          [D]
        </Text>
      )}
      <Text
        fontFamily="mono"
        fontSize="12px"
        color={selected ? 'ink' : 'ink2'}
        fontWeight={selected ? '700' : '500'}
        letterSpacing="0.04em"
      >
        {sector.name}
      </Text>
      {avgChgPct !== null ? (
        <Text fontFamily="mono" fontSize="11px" color={avgChgPct >= 0 ? 'up' : 'down'}>
          {avgChgPct >= 0 ? '+' : ''}
          {(avgChgPct * 100).toFixed(2)}%
        </Text>
      ) : (
        <Text fontFamily="mono" fontSize="11px" color="ink3">
          —
        </Text>
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
  );
}
