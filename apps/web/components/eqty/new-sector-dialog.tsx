'use client';

/**
 * Modal for the SectorsPanel `+ NEW` action. Two flavours share a
 * single shell:
 *   - **User sector** — title only; saves an empty basket the user
 *     fills in later from the list view.
 *   - **Dynamic sector** — NL query → run preview (DSL tree + matches)
 *     → save with the captured codes + evidence map.
 */

import { Box, Button, Flex, Input, Text } from '@chakra-ui/react';
import type { NlScreenResult, ScreenMatchView } from '@quant/shared';
import { useState } from 'react';

import { useNlScreen } from '../../lib/hooks/use-nl-screen.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../../lib/stores/ui.store.js';
import { DslTree } from '../dsl/dsl-tree.js';

type Tab = 'user' | 'dynamic';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function NewSectorDialog({ open, onClose }: Props): React.ReactElement | null {
  const [tab, setTab] = useState<Tab>('user');
  const [title, setTitle] = useState('');
  const [nl, setNl] = useState('');
  const [preview, setPreview] = useState<NlScreenResult | null>(null);
  const screen = useNlScreen();
  const upsert = useSectorsStore((s) => s.upsert);
  const setActiveSector = useUiStore((s) => s.setActiveSector);

  if (!open) return null;

  const reset = (): void => {
    setTitle('');
    setNl('');
    setPreview(null);
    setTab('user');
  };

  const closeAndReset = (): void => {
    reset();
    onClose();
  };

  const onRun = (): void => {
    const trimmed = nl.trim();
    if (trimmed.length === 0 || screen.isPending) return;
    screen.mutate(
      { nl: trimmed },
      {
        onSuccess: (data) => {
          setPreview(data);
        },
      },
    );
  };

  const saveUser = (): void => {
    const t = title.trim();
    if (t.length === 0) return;
    const id = makeId(t);
    const s: Sector = {
      id,
      name: t,
      kind: 'user',
      count: 0,
      meta: 'manual basket',
      chgPct: null,
      codes: [],
    };
    upsert(s);
    setActiveSector(id);
    closeAndReset();
  };

  const saveDynamic = (): void => {
    const t = title.trim();
    if (t.length === 0 || preview === null) return;
    const id = makeId(t);
    const evidence = matchesToEvidence(preview.matches);
    const codes = preview.matches.map((m) => m.code);
    const s: Sector = {
      id,
      name: t,
      kind: 'dynamic',
      count: codes.length,
      meta: preview.nl,
      chgPct: null,
      codes,
      nl: preview.nl,
      evidence,
    };
    upsert(s);
    setActiveSector(id);
    closeAndReset();
  };

  return (
    <Box
      position="fixed"
      inset={0}
      bg="rgba(0,0,0,0.45)"
      zIndex={2000}
      display="flex"
      alignItems="center"
      justifyContent="center"
      onClick={closeAndReset}
    >
      <Box
        onClick={(e) => {
          e.stopPropagation();
        }}
        bg="panel"
        color="ink"
        w="640px"
        maxW="92vw"
        maxH="86vh"
        display="flex"
        flexDirection="column"
        borderWidth="1px"
        borderColor="accent"
        boxShadow="0 14px 48px rgba(0,0,0,0.55)"
      >
        <Header onClose={closeAndReset} />
        <Tabs tab={tab} setTab={setTab} />
        <Box flex="1" overflow="auto" p="14px">
          {tab === 'user' ? (
            <UserForm title={title} setTitle={setTitle} />
          ) : (
            <DynamicForm
              title={title}
              setTitle={setTitle}
              nl={nl}
              setNl={setNl}
              onRun={onRun}
              isRunning={screen.isPending}
              error={screen.error?.message ?? null}
              preview={preview}
            />
          )}
        </Box>
        <Footer
          onCancel={closeAndReset}
          onSave={tab === 'user' ? saveUser : saveDynamic}
          canSave={
            tab === 'user'
              ? title.trim().length > 0
              : title.trim().length > 0 && preview !== null
          }
          saveLabel={tab === 'user' ? 'CREATE' : 'SAVE'}
        />
      </Box>
    </Box>
  );
}

function Header({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <Flex
      align="center"
      gap="8px"
      px="14px"
      h="36px"
      borderBottomWidth="1px"
      borderColor="line"
      bg="panel3"
      flexShrink={0}
    >
      <Text fontFamily="mono" fontSize="11px" color="accent" fontWeight="700" letterSpacing="0.18em">
        002
      </Text>
      <Text fontFamily="mono" fontSize="11px" color="ink2" letterSpacing="0.18em" textTransform="uppercase">
        new sector
      </Text>
      <Box
        as="button"
        ml="auto"
        aria-label="close"
        onClick={onClose}
        w="20px"
        h="20px"
        display="grid"
        placeItems="center"
        fontFamily="mono"
        fontSize="13px"
        color="ink3"
        bg="transparent"
        cursor="pointer"
        _hover={{ color: 'accent' }}
      >
        ×
      </Box>
    </Flex>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }): React.ReactElement {
  return (
    <Flex borderBottomWidth="1px" borderColor="line" bg="panel" flexShrink={0}>
      {(['user', 'dynamic'] as const).map((id) => {
        const active = tab === id;
        return (
          <Box
            as="button"
            key={id}
            onClick={(): void => {
              setTab(id);
            }}
            flex="1"
            px="14px"
            py="9px"
            bg={active ? 'accentBg' : 'transparent'}
            color={active ? 'accent' : 'ink2'}
            borderBottomWidth={active ? '2px' : 0}
            borderBottomColor="accent"
            fontFamily="mono"
            fontSize="11px"
            letterSpacing="0.18em"
            textTransform="uppercase"
            fontWeight={active ? '700' : '500'}
            cursor="pointer"
            _hover={active ? {} : { bg: 'hover' }}
          >
            {id} sector
          </Box>
        );
      })}
    </Flex>
  );
}

function UserForm({
  title,
  setTitle,
}: {
  title: string;
  setTitle: (v: string) => void;
}): React.ReactElement {
  return (
    <Flex direction="column" gap="10px">
      <Field label="TITLE">
        <Input
          value={title}
          onChange={(e): void => {
            setTitle(e.target.value);
          }}
          placeholder="e.g. 我的白酒篮"
          autoFocus
          bg="panel"
          borderWidth="1px"
          borderColor="line"
          h="32px"
          px="10px"
          fontFamily="mono"
          fontSize="12px"
          borderRadius="0"
          _focus={{ borderColor: 'accent', boxShadow: 'none' }}
        />
      </Field>
      <Hint>// empty basket — fill members later from the list panel</Hint>
    </Flex>
  );
}

interface DynamicFormProps {
  readonly title: string;
  readonly setTitle: (v: string) => void;
  readonly nl: string;
  readonly setNl: (v: string) => void;
  readonly onRun: () => void;
  readonly isRunning: boolean;
  readonly error: string | null;
  readonly preview: NlScreenResult | null;
}

function DynamicForm({
  title,
  setTitle,
  nl,
  setNl,
  onRun,
  isRunning,
  error,
  preview,
}: DynamicFormProps): React.ReactElement {
  return (
    <Flex direction="column" gap="12px">
      <Field label="TITLE">
        <Input
          value={title}
          onChange={(e): void => {
            setTitle(e.target.value);
          }}
          placeholder="e.g. 突破20日均线"
          bg="panel"
          borderWidth="1px"
          borderColor="line"
          h="32px"
          px="10px"
          fontFamily="mono"
          fontSize="12px"
          borderRadius="0"
          _focus={{ borderColor: 'accent', boxShadow: 'none' }}
        />
      </Field>
      <Field label="NL">
        <Flex gap="6px">
          <Input
            value={nl}
            onChange={(e): void => {
              setNl(e.target.value);
            }}
            onKeyDown={(e): void => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onRun();
              }
            }}
            placeholder="自然语言筛选语句…"
            bg="panel"
            borderWidth="1px"
            borderColor="line"
            h="32px"
            px="10px"
            fontFamily="mono"
            fontSize="12px"
            borderRadius="0"
            _focus={{ borderColor: 'accent', boxShadow: 'none' }}
          />
          <Button
            onClick={onRun}
            loading={isRunning}
            disabled={nl.trim().length === 0}
            bg="accent"
            color="panel"
            h="32px"
            px="14px"
            fontFamily="mono"
            fontSize="11px"
            fontWeight="700"
            letterSpacing="0.16em"
            borderRadius="0"
            _hover={{ bg: 'accentDark' }}
          >
            RUN ▶
          </Button>
        </Flex>
      </Field>
      {error !== null && (
        <Text color="up" fontFamily="mono" fontSize="11px">
          ✘ {error}
        </Text>
      )}
      {preview !== null && (
        <Flex direction="column" gap="8px">
          <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.16em" textTransform="uppercase">
            // preview · {preview.matches.length} hit(s)
          </Text>
          <Box maxH="220px" overflow="auto" borderWidth="1px" borderColor="line" p="10px" bg="panel3">
            <DslTree screenPlan={preview.screenPlan} universePlan={preview.universePlan} />
          </Box>
          <Box maxH="160px" overflow="auto" borderWidth="1px" borderColor="line">
            <MatchPreviewList matches={preview.matches.slice(0, 50)} />
          </Box>
        </Flex>
      )}
    </Flex>
  );
}

function MatchPreviewList({ matches }: { matches: readonly ScreenMatchView[] }): React.ReactElement {
  if (matches.length === 0) {
    return (
      <Text px="10px" py="10px" fontFamily="mono" fontSize="11px" color="ink3">
        // no matches
      </Text>
    );
  }
  return (
    <Box>
      {matches.map((m) => (
        <Flex
          key={m.code}
          align="center"
          gap="10px"
          px="10px"
          py="5px"
          borderBottomWidth="1px"
          borderColor="line2"
          fontFamily="mono"
          fontSize="11px"
        >
          <Text color="ink" fontWeight="600" w="60px">
            {m.code}
          </Text>
          <Text color="ink3" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
            {Object.entries(m.evidence)
              .map(([k, v]) => `${k}=${formatEvidence(v)}`)
              .join(' · ')}
          </Text>
        </Flex>
      ))}
    </Box>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Flex direction="column" gap="4px">
      <Text fontFamily="mono" fontSize="9px" color="ink3" letterSpacing="0.18em" fontWeight="700">
        {label}
      </Text>
      {children}
    </Flex>
  );
}

function Hint({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text fontFamily="mono" fontSize="11px" color="ink3" letterSpacing="0.06em">
      {children}
    </Text>
  );
}

interface FooterProps {
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly canSave: boolean;
  readonly saveLabel: string;
}

function Footer({ onCancel, onSave, canSave, saveLabel }: FooterProps): React.ReactElement {
  return (
    <Flex
      align="center"
      gap="8px"
      px="14px"
      py="10px"
      borderTopWidth="1px"
      borderColor="line"
      bg="panel3"
      flexShrink={0}
    >
      <Button
        onClick={onCancel}
        bg="transparent"
        color="ink2"
        borderWidth="1px"
        borderColor="line"
        h="auto"
        px="14px"
        py="6px"
        fontFamily="mono"
        fontSize="11px"
        letterSpacing="0.18em"
        borderRadius="0"
        _hover={{ borderColor: 'ink2' }}
      >
        CANCEL
      </Button>
      <Button
        ml="auto"
        onClick={onSave}
        disabled={!canSave}
        bg={canSave ? 'accent' : 'badgeBg'}
        color={canSave ? 'panel' : 'ink3'}
        h="auto"
        px="16px"
        py="6px"
        fontFamily="mono"
        fontSize="11px"
        fontWeight="700"
        letterSpacing="0.18em"
        borderRadius="0"
        _hover={canSave ? { bg: 'accentDark' } : {}}
      >
        {saveLabel}
      </Button>
    </Flex>
  );
}

function makeId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const base = slug.length === 0 ? 'sec' : slug;
  // Suffix prevents collisions across same-titled sectors (and keeps
  // ALL_SECTOR_ID untouched).
  const suffix = Math.random().toString(36).slice(2, 8);
  const id = `${base}-${suffix}`;
  return id === ALL_SECTOR_ID ? `${id}-x` : id;
}

function matchesToEvidence(
  matches: readonly ScreenMatchView[],
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const m of matches) {
    out[m.code] = { ...m.evidence };
  }
  return out;
}

function formatEvidence(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v);
}
