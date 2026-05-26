'use client';

/**
 * SCR.DSL — owns the dynamic-sector translation surface end to end:
 *
 *   1. an editable NL prompt at the top (click to edit, ENTER/SAVE
 *      re-runs the screen and updates the active sector)
 *   2. the parsed plan tree (universe / screen / rank) returned by the
 *      NL→DSL translator, so users can compare "what they typed" with
 *      "what the parser understood"
 *
 * Always wrapped in FeatView for consistent pane chrome (minimize /
 * fullscreen / persistence). Embedded inline inside the EQ.LIST
 * dynamic header — the host gives it a bounded height and the body
 * scrolls internally.
 */

import { Box, Button, Flex, Text, Textarea } from '@chakra-ui/react';
import { useEffect, useState } from 'react';

import { refreshSector } from '../../lib/api/sectors.js';
import { Feat } from '../../lib/eqty/feat.js';
import { formatRelativeTime } from '../../lib/fp/eq-list-fp.js';
import { useNlScreen } from '../../lib/hooks/use-nl-screen.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { DslTree } from '../dsl/dsl-tree.js';
import { FeatView } from '../feat-view/feat-view.js';
import { FeatViewHeaderRight } from '../feat-view/feat-view-header.js';
import { MonoButton } from '../ui/mono-button.js';

export function FeatScrDsl(): React.ReactElement {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const sectors = useSectorsStore((s) => s.sectors);
  const sector = sectors.find((s) => s.id === activeSectorId) ?? null;
  const isDynamic = sector !== null && sector.kind === 'dynamic';
  const hasPlan = isDynamic && sector.screenPlan !== undefined;

  return (
    <FeatView
      feat={Feat.ScreenDsl}
      status={hasPlan ? 'green' : 'amber'}
      titleSlot={isDynamic ? <LastScreenedLabel sector={sector} /> : undefined}
      right={isDynamic ? <RefreshAction sector={sector} /> : undefined}
    >
      {isDynamic ? <NlEditor sector={sector} /> : null}
      <Box px="10px" py="8px">
        {hasPlan ? <PlanTree sector={sector} /> : <EmptyHint sector={sector} />}
      </Box>
    </FeatView>
  );
}

/**
 * Header right slot — "re-run this screen". Replaces the old
 * `DynamicRefreshBar` that used to live inside the EQ.LIST body
 * (gone since the 2026-05 split moved DSL out into its own pane).
 * Disabled until the sector has a parsed `screenPlan`; otherwise
 * there's nothing to re-execute.
 */
function RefreshAction({ sector }: { sector: Sector }): React.ReactElement {
  const upsert = useSectorsStore((s) => s.upsert);
  const [pending, setPending] = useState(false);
  const canRefresh = sector.screenPlan !== undefined;
  const onClick = (): void => {
    if (!canRefresh || pending) return;
    setPending(true);
    refreshSector(sector.id)
      .then((next) => {
        upsert(next);
      })
      .catch((e: unknown) => {
        // Surface as notification rather than swallow — the user
        // pressed REFRESH and deserves to know it failed. Keep it
        // simple: console error + leave the pending flag down.
        console.error('refresh sector failed:', e);
      })
      .finally(() => {
        setPending(false);
      });
  };
  return (
    <FeatViewHeaderRight>
      <MonoButton
        icon="refresh"
        label={canRefresh ? (pending ? 'refreshing…' : 'rerun screen') : 'no plan to rerun'}
        onClick={onClick}
        disabled={!canRefresh || pending}
      />
    </FeatViewHeaderRight>
  );
}

/**
 * "last screened: Nm ago" caption rendered as the DSL pane's
 * titleSlot. The relative-time pass needs a `Date.now()` injection —
 * the formatter is pure but we cap the disable here at the runtime
 * edge (CLAUDE.md §1.2 single bridge per file).
 */
function LastScreenedLabel({ sector }: { sector: Sector }): React.ReactElement {
  return (
    <Text fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.14em">
      {/* eslint-disable-next-line no-restricted-globals -- cosmetic
          relative-time ticks on render. */}
      last: {formatRelativeTime(sector.lastScreenedAt, Date.now())}
    </Text>
  );
}

function NlEditor({ sector }: { sector: Sector }): React.ReactElement {
  const upsert = useSectorsStore((s) => s.upsert);
  const screen = useNlScreen();
  const sourceText = sector.nl ?? sector.meta;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sourceText);
  useEffect(() => {
    setDraft(sourceText);
  }, [sourceText]);

  const onSave = (): void => {
    const next = draft.trim();
    if (next.length === 0 || screen.isPending) return;
    screen.mutate(
      { nl: next },
      {
        onSuccess: (data) => {
          upsert({
            ...sector,
            nl: data.nl,
            meta: data.nl,
            count: data.matches.length,
            codes: data.matches.map((m) => m.code),
            evidence: matchesToEvidenceMap(data.matches),
            screenPlan: data.screenPlan,
            universePlan: data.universePlan,
            rank: data.rank,
          });
          setEditing(false);
        },
      },
    );
  };

  return (
    <Box
      px="10px"
      py="8px"
      borderBottomWidth="1px"
      borderColor="glass.line"
      bg="glass.panelSoft"
      backdropFilter="blur(12px)"
      flexShrink={0}
    >
      <Flex align="flex-start" gap="8px">
        <Text
          color="down"
          fontFamily="mono"
          fontSize="sm"
          fontWeight="700"
          mt="2px"
          flexShrink={0}
        >
          $
        </Text>
        {editing ? (
          <Textarea
            value={draft}
            onChange={(e): void => {
              setDraft(e.target.value);
            }}
            autoFocus
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            bg="panel"
            borderWidth="1px"
            borderColor="accent"
            borderRadius="0"
            fontFamily="mono"
            fontSize="sm"
            color="ink"
            px="8px"
            py="4px"
            flex="1"
            minH="auto"
            resize="vertical"
            _focus={{ borderColor: 'accent', boxShadow: 'none' }}
          />
        ) : (
          <Text
            fontFamily="mono"
            fontSize="sm"
            color="ink"
            whiteSpace="pre-wrap"
            wordBreak="break-word"
            flex="1"
            cursor="text"
            _hover={{ color: 'accent' }}
            onClick={(): void => {
              setEditing(true);
            }}
            title="click to edit"
          >
            {sourceText}
          </Text>
        )}
        <NlEditButtons
          editing={editing}
          pending={screen.isPending}
          onCancel={(): void => {
            setDraft(sourceText);
            setEditing(false);
          }}
          onEdit={(): void => setEditing(true)}
          onSave={onSave}
        />
      </Flex>
      {screen.isError && (
        <Text mt="4px" fontFamily="mono" fontSize="xs" color="up">
          // {screen.error.message}
        </Text>
      )}
    </Box>
  );
}

interface NlEditButtonsProps {
  readonly editing: boolean;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onEdit: () => void;
  readonly onSave: () => void;
}

function NlEditButtons({
  editing,
  pending,
  onCancel,
  onEdit,
  onSave,
}: NlEditButtonsProps): React.ReactElement {
  return (
    <Flex gap="6px" flexShrink={0}>
      {editing && (
        <Button
          h="22px"
          px="8px"
          bg="panel"
          color="ink2"
          borderWidth="1px"
          borderColor="line"
          borderRadius="0"
          fontFamily="mono"
          fontSize="xs"
          letterSpacing="0.14em"
          onClick={onCancel}
          disabled={pending}
        >
          CANCEL
        </Button>
      )}
      <Button
        h="22px"
        px="10px"
        bg={editing ? 'accent' : 'panel'}
        color={editing ? 'panel' : 'ink2'}
        borderWidth="1px"
        borderColor={editing ? 'accent' : 'line'}
        borderRadius="0"
        fontFamily="mono"
        fontSize="xs"
        letterSpacing="0.14em"
        fontWeight="700"
        loading={pending}
        onClick={editing ? onSave : onEdit}
      >
        {editing ? 'SAVE' : 'EDIT'}
      </Button>
    </Flex>
  );
}

function PlanTree({ sector }: { sector: Sector }): React.ReactElement | null {
  if (sector.screenPlan === undefined) return null;
  return (
    <DslTree
      screenPlan={sector.screenPlan}
      universePlan={sector.universePlan ?? null}
      rank={sector.rank ?? null}
    />
  );
}

function EmptyHint({ sector }: { sector: Sector | null }): React.ReactElement {
  const hint =
    sector === null
      ? 'no sector selected'
      : sector.kind === 'dynamic'
        ? 'no plan available'
        : 'pick a dynamic sector';
  return (
    <Text fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.06em">
      // {hint}
    </Text>
  );
}

function matchesToEvidenceMap(
  matches: readonly {
    readonly code: string;
    readonly evidence: Readonly<Record<string, unknown>>;
  }[],
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const out: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const m of matches) out[m.code] = { ...m.evidence };
  return out;
}
