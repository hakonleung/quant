'use client';

/**
 * `LDG.MAIN` — personal ledger pane.
 *
 * One Feat with three internal tabs (List / Daily / Cumulative) plus an
 * "AI" toggle that overlays the analysis panel. Mutations go through
 * `useLedgerMutations`; the AI side has its own hook pair (cached read +
 * fresh-call mutation).
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import { LEDGER_EXPORT_URL } from '../../lib/api/endpoints.js';
import { Feat } from '../../lib/eqty/feat.js';
import { ConfirmCancelled, useConfirm } from '../../lib/hooks/use-confirm.js';
import { notify } from '../../lib/stores/notify.store.js';
import {
  useLedgerAnalyzeMutation,
  useLedgerCachedAnalysis,
  useLedgerEnriched,
  useLedgerMutations,
} from '../../lib/hooks/use-ledger.js';
import type { LedgerEntry } from '@quant/shared';
import { useState } from 'react';

import { useFeatHotkeys } from '../../lib/ui-cmd/hooks/use-feat-hotkeys.js';
import { FeatView } from '../feat-view/feat-view.js';
import { MonoButton } from '../ui/mono-button.js';
import { LedgerAddForm } from './ledger-add-form.js';
import { LedgerAiPanel } from './ledger-ai-panel.js';
import { LedgerChart } from './ledger-chart.js';
import { LedgerImportDialog } from './ledger-import-dialog.js';
import { LedgerList } from './ledger-list.js';
import { LedgerSummaryBar } from './ledger-summary-bar.js';

type Tab = 'list' | 'daily' | 'cumulative';

interface FeatLedgerProps {
  /** Hosted inside USR.MAIN as a tab — drop the FeatView chrome. */
  readonly bare?: boolean;
}

export function FeatLedger({ bare }: FeatLedgerProps = {}): React.ReactElement {
  const { entries, enriched, error } = useLedgerEnriched();
  const mutations = useLedgerMutations();
  const cachedAnalysis = useLedgerCachedAnalysis();
  const analyze = useLedgerAnalyzeMutation();
  const { guard: confirmGuard, comp: confirmComp } = useConfirm();

  const [tab, setTab] = useState<Tab>('list');
  const [aiOpen, setAiOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // `A` (USR.ledger sub-scope) — open the add-entry form. Bound here
  // rather than centrally because the form's open state is local React
  // state. The cell metadata lives in global-cells.ts.
  useFeatHotkeys(Feat.UsrMain, {
    'ui.ledger-add-open': () => setAddOpen(true),
  });
  const [editing, setEditing] = useState<LedgerEntry | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const busy =
    mutations.create.isPending ||
    mutations.patch.isPending ||
    mutations.remove.isPending ||
    mutations.importEntries.isPending;

  const existingDates = entries.map((e) => e.date);
  const status: 'red' | 'amber' | undefined =
    error !== null ? 'red' : actionError !== null ? 'amber' : undefined;

  const onAdd = async (entry: LedgerEntry): Promise<void> => {
    setActionError(null);
    try {
      await mutations.create.mutateAsync(entry);
      setAddOpen(false);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const onEditSubmit = async (entry: LedgerEntry): Promise<void> => {
    setActionError(null);
    if (editing === null) return;
    try {
      await mutations.patch.mutateAsync({
        date: editing.date,
        pnlAmount: entry.pnlAmount,
        ...(entry.closingPosition !== undefined
          ? { closingPosition: entry.closingPosition }
          : { closingPosition: null }),
      });
      setEditing(null);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const onDelete = async (date: string): Promise<void> => {
    setActionError(null);
    try {
      // Themed confirm replaces native window.confirm — keeps the
      // workbench chrome consistent (mono panel + accent button) and
      // unblocks rendering while the user decides.
      await confirmGuard({
        title: 'LDG.DELETE',
        message: `删除 ${date} 的记录？此操作不可撤销。`,
        confirmLabel: '删除',
        cancelLabel: '取消',
      });
      await mutations.remove.mutateAsync(date);
      notify.success({ title: `已删除 ${date}` });
    } catch (err) {
      // ConfirmCancelled is the user clicking "cancel" — not an error.
      if (err instanceof ConfirmCancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      notify.error({ title: '删除失败', body: message });
    }
  };

  const onImport = async (incoming: readonly LedgerEntry[]): Promise<void> => {
    setActionError(null);
    try {
      await mutations.importEntries.mutateAsync(incoming);
      setImportOpen(false);
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const onAnalyze = async (force: boolean): Promise<void> => {
    setActionError(null);
    if (force) {
      // Force = paid LLM call (cache bypass). Make the cost visible —
      // a stray click on FORCE was burning Kimi tokens silently before.
      try {
        await confirmGuard({
          title: 'LDG.FORCE',
          message: '本次将绕过缓存调用付费模型（Kimi Pro 优先），约消耗 ~1k tokens。继续？',
          confirmLabel: '继续',
          cancelLabel: '取消',
        });
      } catch (err) {
        if (err instanceof ConfirmCancelled) return;
        throw err;
      }
    }
    setAiOpen(true);
    try {
      await analyze.mutateAsync(force);
      if (force) notify.success({ title: 'AI 复盘完成', body: '已替换缓存内容。' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionError(message);
      notify.error({ title: 'AI 复盘失败', body: message });
    }
  };

  return (
    <FeatView feat={Feat.Ledger} bare={bare ?? false} {...(status !== undefined ? { status } : {})}>
      <Flex
        px="10px"
        py="4px"
        gap="6px"
        align="center"
        borderBottomWidth="1px"
        borderColor="term.line"
        flexShrink={0}
      >
        <TabButton active={tab === 'list'} onClick={(): void => setTab('list')}>
          LIST
        </TabButton>
        <TabButton active={tab === 'daily'} onClick={(): void => setTab('daily')}>
          DAILY
        </TabButton>
        <TabButton active={tab === 'cumulative'} onClick={(): void => setTab('cumulative')}>
          CUM
        </TabButton>
        <Box flex="1" />
        <MonoButton
          icon="add"
          label="add entry"
          disabled={busy}
          onClick={(): void => setAddOpen(true)}
        >
          ADD
        </MonoButton>
        <MonoButton
          icon="upload"
          label="import"
          disabled={busy}
          onClick={(): void => setImportOpen(true)}
        >
          IMP
        </MonoButton>
        <MonoButton
          icon="download"
          label="export"
          onClick={(): void => {
            if (typeof window !== 'undefined') window.location.href = LEDGER_EXPORT_URL;
          }}
        >
          EXP
        </MonoButton>
        <MonoButton
          icon="ai"
          label="ai analyze"
          disabled={analyze.isPending}
          onClick={(): void => {
            void onAnalyze(false);
          }}
        >
          AI
        </MonoButton>
      </Flex>
      <LedgerSummaryBar enriched={enriched} />
      <Box flex="1" minH={0} display="flex" flexDirection="column" overflow="hidden">
        {tab === 'list' && (
          <LedgerList
            enriched={enriched}
            onEdit={(date): void => {
              const found = entries.find((e) => e.date === date);
              setEditing(found ?? null);
            }}
            onDelete={(date): void => {
              void onDelete(date);
            }}
            busy={busy}
          />
        )}
        {tab === 'daily' && <LedgerChart enriched={enriched} mode="daily" />}
        {tab === 'cumulative' && <LedgerChart enriched={enriched} mode="cumulative" />}
      </Box>
      {(aiOpen || cachedAnalysis.data !== null) && (
        <Box
          borderTopWidth="1px"
          borderColor="term.line"
          flexShrink={0}
          display="flex"
          flexDirection="column"
          minH={0}
          maxH="240px"
          overflow="hidden"
        >
          <Flex
            px="10px"
            py="4px"
            gap="10px"
            align="center"
            borderBottomWidth="1px"
            borderColor="term.line"
            flexShrink={0}
          >
            <Text
              fontSize="9px"
              letterSpacing="0.18em"
              color="accent"
              fontFamily="mono"
              fontWeight="700"
            >
              AI 复盘
            </Text>
            <Box flex="1" />
            <MonoButton
              icon="refresh"
              label="force refresh"
              disabled={analyze.isPending}
              onClick={(): void => {
                void onAnalyze(true);
              }}
            >
              FORCE
            </MonoButton>
            <MonoButton icon="close" label="close ai" onClick={(): void => setAiOpen(false)} />
          </Flex>
          <Box flex="1" minH={0} overflowY="auto">
            <LedgerAiPanel
              analysis={analyze.data ?? cachedAnalysis.data ?? null}
              loading={analyze.isPending}
              error={analyze.error instanceof Error ? analyze.error.message : null}
            />
          </Box>
        </Box>
      )}
      {addOpen && (
        <LedgerAddForm
          mode="add"
          existingDates={existingDates}
          onCancel={(): void => setAddOpen(false)}
          onSubmit={onAdd}
          busy={busy}
        />
      )}
      {editing !== null && (
        <LedgerAddForm
          mode="edit"
          existingDates={existingDates}
          editing={editing}
          onCancel={(): void => setEditing(null)}
          onSubmit={onEditSubmit}
          busy={busy}
        />
      )}
      {importOpen && (
        <LedgerImportDialog
          onCancel={(): void => setImportOpen(false)}
          onSubmit={onImport}
          busy={busy}
        />
      )}
      {confirmComp}
    </FeatView>
  );
}

interface TabButtonProps {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps): React.ReactElement {
  return (
    <Box
      as="button"
      px="6px"
      py="2px"
      fontSize="10px"
      fontFamily="mono"
      letterSpacing="0.12em"
      color={active ? 'term.green' : 'term.ink3'}
      borderBottomWidth="1px"
      borderColor={active ? 'term.green' : 'transparent'}
      cursor="pointer"
      onClick={onClick}
    >
      {children}
    </Box>
  );
}
