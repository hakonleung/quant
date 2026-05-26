'use client';

/**
 * Modal for the FeatSecList `+ NEW` action. Two flavours share a
 * single shell:
 *   - **User sector** — title only; saves an empty basket the user
 *     fills in later from the list view.
 *   - **Dynamic sector** — NL query → run preview (DSL tree + matches)
 *     → save with the captured codes + evidence map.
 */

import { Box, Button, Flex, Input, Text } from '@chakra-ui/react';
import { DialogPortal } from '../feat-view/dialog-portal.js';
import type { NlToDslResult, WatchMarket } from '@quant/shared';
import { useState } from 'react';

import { useCurrentUserId } from '../../lib/hooks/use-current-user.js';
import { useNlToDsl } from '../../lib/hooks/use-nl-to-dsl.js';
import { useSectorsStore, type Sector } from '../../lib/stores/sectors.store.js';
import { DslTree } from '../dsl/dsl-tree.js';
import { FeatSectionBar, FeatSectionLabel } from '../feat-view/feat-section.js';
import { FloatingSurface } from '../feat-view/floating-surface.js';

type Tab = 'user' | 'dynamic';

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function NewSectorDialog({ open, onClose }: Props): React.ReactElement | null {
  const [tab, setTab] = useState<Tab>('user');
  const [title, setTitle] = useState('');
  const [market, setMarket] = useState<WatchMarket>('a');
  const [nl, setNl] = useState('');
  const [preview, setPreview] = useState<NlToDslResult | null>(null);
  const screen = useNlToDsl();
  const upsert = useSectorsStore((s) => s.upsert);
  const currentUserId = useCurrentUserId() ?? '';

  if (!open) return null;

  const reset = (): void => {
    setTitle('');
    setMarket('a');
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
    // Empty id signals "new record — let backend assign s{n}". The remote
    // sync hook applies the canonical response, after which the user can
    // pick the freshly assigned sector from the list.
    const s: Sector = {
      id: '',
      name: t,
      kind: 'user',
      market,
      count: 0,
      meta: 'manual basket',
      chgPct: null,
      codes: [],
      createdBy: currentUserId,
      published: false,
    };
    upsert(s);
    closeAndReset();
  };

  const saveDynamic = async (): Promise<void> => {
    const t = title.trim();
    const trimmedNl = nl.trim();
    if (t.length === 0 || trimmedNl.length === 0 || screen.isPending) return;
    // NL → DSL must be in sync with the saved sector. If the user edited
    // the prompt after the last preview (or never previewed), re-translate
    // before persisting so screenPlan / universePlan / rank match `nl`.
    // We never run the actual screen here — codes/evidence are populated
    // lazily on first `sector.refresh`.
    let snapshot: NlToDslResult | null = preview;
    if (snapshot === null || snapshot.nl !== trimmedNl) {
      snapshot = await screen.mutateAsync({ nl: trimmedNl });
      setPreview(snapshot);
    }
    const s: Sector = {
      id: '',
      name: t,
      kind: 'dynamic',
      market: 'a',
      count: 0,
      meta: snapshot.nl,
      chgPct: null,
      codes: [],
      nl: snapshot.nl,
      screenPlan: snapshot.screenPlan,
      universePlan: snapshot.universePlan,
      rank: snapshot.rank,
      createdBy: currentUserId,
      published: false,
    };
    upsert(s);
    closeAndReset();
  };

  return (
    <DialogPortal>
      <Box
      position="fixed"
      inset={0}
      bg="overlay"
      zIndex="dialog"
      display="flex"
      alignItems="center"
      justifyContent="center"
      onClick={closeAndReset}
    >
      <FloatingSurface
        role="dialog"
        aria-modal="true"
        aria-labelledby="sec-new-dialog-title"
        onClick={(e) => {
          e.stopPropagation();
        }}
        w="640px"
        maxW="92vw"
        maxH="86vh"
        display="flex"
        flexDirection="column"
      >
        <Header onClose={closeAndReset} />
        <Tabs tab={tab} setTab={setTab} />
        <Box flex="1" overflow="auto" p="14px">
          {tab === 'user' ? (
            <UserForm title={title} setTitle={setTitle} market={market} setMarket={setMarket} />
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
          onSave={
            tab === 'user'
              ? saveUser
              : (): void => {
                  void saveDynamic();
                }
          }
          canSave={
            tab === 'user'
              ? title.trim().length > 0
              : title.trim().length > 0 && nl.trim().length > 0 && !screen.isPending
          }
          saveLabel={tab === 'user' ? 'CREATE' : 'SAVE'}
        />
      </FloatingSurface>
    </Box>
    </DialogPortal>
  );
}

function Header({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <FeatSectionBar
      id="sec-new-dialog-title"
      name="MKT.NEW"
      subtitle="new sector"
      right={
        <Box
          as="button"
          aria-label="close"
          onClick={onClose}
          w="20px"
          h="20px"
          display="grid"
          placeItems="center"
          fontFamily="mono"
          fontSize="body"
          color="ink3"
          bg="transparent"
          cursor="pointer"
          _hover={{ color: 'accent' }}
        >
          ×
        </Box>
      }
    />
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }): React.ReactElement {
  return (
    <Flex borderBottomWidth="1px" borderColor="glass.line" bg="transparent" flexShrink={0}>
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
            fontSize="xs"
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
  market,
  setMarket,
}: {
  title: string;
  setTitle: (v: string) => void;
  market: WatchMarket;
  setMarket: (v: WatchMarket) => void;
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
          fontSize="sm"
          borderRadius="sm"
          _focus={{ borderColor: 'accent', boxShadow: 'none' }}
        />
      </Field>
      <Field label="MARKET">
        <Flex gap="6px">
          {(['a', 'hk', 'us'] as const).map((m) => {
            const active = market === m;
            return (
              <Box
                as="button"
                key={m}
                onClick={(): void => {
                  setMarket(m);
                }}
                px="12px"
                h="28px"
                fontFamily="mono"
                fontSize="xs"
                letterSpacing="0.18em"
                textTransform="uppercase"
                borderWidth="1px"
                borderColor={active ? 'accent' : 'line'}
                bg={active ? 'accentBg' : 'panel'}
                color={active ? 'accent' : 'ink2'}
                borderRadius="sm"
                cursor="pointer"
                _hover={active ? {} : { borderColor: 'ink2' }}
              >
                {m}
              </Box>
            );
          })}
        </Flex>
      </Field>
      <Hint>
        {market === 'a'
          ? '// empty basket — fill members later from the list panel'
          : '// basic info only (code + name) — no kline / snapshot in v1'}
      </Hint>
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
  readonly preview: NlToDslResult | null;
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
          fontSize="sm"
          borderRadius="sm"
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
            fontSize="sm"
            borderRadius="sm"
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
            fontSize="xs"
            fontWeight="700"
            letterSpacing="0.16em"
            borderRadius="sm"
            _hover={{ bg: 'accent' }}
          >
            RUN ▶
          </Button>
        </Flex>
      </Field>
      {error !== null && (
        <Text color="up" fontFamily="mono" fontSize="xs">
          ✘ {error}
        </Text>
      )}
      {preview !== null && (
        <Flex direction="column" gap="8px">
          <FeatSectionLabel>// dsl preview · run refresh to populate matches</FeatSectionLabel>
          <Box
            maxH="320px"
            overflow="auto"
            borderWidth="1px"
            borderColor="glass.line"
            borderRadius="sm"
            p="10px"
            bg="glass.panelSoft"
            backdropFilter="blur(12px)"
          >
            <DslTree
              screenPlan={preview.screenPlan}
              universePlan={preview.universePlan}
              rank={preview.rank}
            />
          </Box>
        </Flex>
      )}
    </Flex>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Flex direction="column" gap="4px">
      <FeatSectionLabel>{label}</FeatSectionLabel>
      {children}
    </Flex>
  );
}

function Hint({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.06em">
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
      borderColor="glass.line"
      bg="glass.panelSoft"
      backdropFilter="blur(12px)"
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
        fontSize="xs"
        letterSpacing="0.18em"
        borderRadius="sm"
        _hover={{ borderColor: 'ink2' }}
      >
        CANCEL
      </Button>
      <Button
        ml="auto"
        onClick={onSave}
        disabled={!canSave}
        bg={canSave ? 'accent' : 'panel3'}
        color={canSave ? 'panel' : 'ink3'}
        h="auto"
        px="16px"
        py="6px"
        fontFamily="mono"
        fontSize="xs"
        fontWeight="700"
        letterSpacing="0.18em"
        borderRadius="sm"
        _hover={canSave ? { bg: 'accent', opacity: 0.85 } : {}}
      >
        {saveLabel}
      </Button>
    </Flex>
  );
}

