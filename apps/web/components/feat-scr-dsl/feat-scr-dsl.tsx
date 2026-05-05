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

import { Feat } from '../../lib/eqty/feat.js';
import { useNlScreen } from '../../lib/hooks/use-nl-screen.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { DslTree } from '../dsl/dsl-tree.js';
import { FeatView } from '../feat-view/feat-view.js';

export function FeatScrDsl(): React.ReactElement {
  const activeSectorId = useUiStore((s) => s.activeSectorId);
  const sectors = useSectorsStore((s) => s.sectors);
  const sector = sectors.find((s) => s.id === activeSectorId) ?? null;
  const isDynamic = sector !== null && sector.kind === 'dynamic';
  const hasPlan = isDynamic && sector.screenPlan !== undefined;

  return (
    <FeatView feat={Feat.ScreenDsl} status={hasPlan ? 'green' : 'amber'}>
      {isDynamic ? <NlEditor sector={sector} /> : null}
      <Box px="10px" py="8px">
        {hasPlan ? <PlanTree sector={sector} /> : <EmptyHint sector={sector} />}
      </Box>
    </FeatView>
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
    <Box px="10px" py="8px" borderBottomWidth="1px" borderColor="line" bg="panel3" flexShrink={0}>
      <Flex align="flex-start" gap="8px">
        <Text
          color="prompt"
          fontFamily="mono"
          fontSize="12px"
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
            fontSize="12px"
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
            fontSize="12px"
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
        <Text mt="4px" fontFamily="mono" fontSize="10px" color="up">
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
          fontSize="10px"
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
        fontSize="10px"
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
    <Text fontFamily="mono" fontSize="11px" color="ink3" letterSpacing="0.06em">
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
