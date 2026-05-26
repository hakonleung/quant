'use client';

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { DialogPortal } from '../feat-view/dialog-portal.js';
import { LedgerEntrySchema, type LedgerEntry } from '@quant/shared';
import { useRef, useState } from 'react';
import { z } from 'zod';

const ImportShapeSchema = z.object({ entries: z.array(LedgerEntrySchema) });

interface LedgerImportDialogProps {
  readonly onCancel: () => void;
  readonly onSubmit: (entries: readonly LedgerEntry[]) => Promise<void> | void;
  readonly busy: boolean;
}

export function LedgerImportDialog({
  onCancel,
  onSubmit,
  busy,
}: LedgerImportDialogProps): React.ReactElement {
  const fileRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<readonly LedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File): Promise<void> => {
    setError(null);
    try {
      const text = await file.text();
      const raw: unknown = JSON.parse(text);
      const parsed = ImportShapeSchema.safeParse(raw);
      if (!parsed.success) {
        // Allow a bare array too — common when the user exports just `entries`.
        const arr = z.array(LedgerEntrySchema).safeParse(raw);
        if (arr.success) {
          setEntries(arr.data);
          return;
        }
        setError(`格式不符合 LedgerSnapshot：${parsed.error.issues[0]?.message ?? ''}`);
        return;
      }
      setEntries(parsed.data.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (entries === null) return;
    try {
      await onSubmit(entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <DialogPortal>
      <Flex
      position="fixed"
      inset="0"
      bg="overlay"
      align="center"
      justify="center"
      zIndex="dialog"
      onMouseDown={(e): void => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <Box
        role="dialog"
        aria-modal="true"
        aria-labelledby="ldg-import-dialog-title"
        aria-describedby="ldg-import-dialog-desc"
        className="glass-strong"
        borderWidth="1px"
        borderRadius="lg"
        boxShadow="glassStrong"
        p="16px"
        minW="360px"
        maxW="92vw"
      >
        <Text
          id="ldg-import-dialog-title"
          fontSize="xs"
          letterSpacing="0.18em"
          color="accent"
          fontFamily="mono"
          fontWeight="700"
          mb="10px"
        >
          LDG.IMPORT
        </Text>
        <Text id="ldg-import-dialog-desc" fontSize="xs" color="ink2" mb="10px">
          选择导出的 JSON 文件 — 同日期记录会被覆盖。
        </Text>
        <label>
          <Text as="span" srOnly>
            选择 JSON 文件
          </Text>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            aria-describedby={error !== null ? 'ldg-import-error' : undefined}
            onChange={(e): void => {
              const file = e.currentTarget.files?.[0];
              if (file) void handleFile(file);
            }}
            style={{ fontSize: 'var(--chakra-font-sizes-sm)', fontFamily: 'monospace' }}
          />
        </label>
        {entries !== null && (
          <Text fontSize="xs" color="ink3" mt="6px" fontFamily="mono">
            待导入 {String(entries.length)} 条
          </Text>
        )}
        {error !== null && (
          <Text
            id="ldg-import-error"
            role="alert"
            fontSize="xs"
            color="up"
            mt="6px"
            fontFamily="mono"
          >
            {error}
          </Text>
        )}
        <Flex gap="8px" justify="flex-end" mt="14px">
          <Button size="xs" variant="outline" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            size="xs"
            colorPalette="accent"
            onClick={(): void => {
              void handleSubmit();
            }}
            loading={busy}
            disabled={busy || entries === null}
          >
            导入
          </Button>
        </Flex>
      </Box>
    </Flex>
    </DialogPortal>
  );
}
