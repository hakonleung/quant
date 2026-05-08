'use client';

import { Box, Button, Flex, Input, Text } from '@chakra-ui/react';
import { LedgerEntrySchema, type LedgerEntry } from '@quant/shared';
import { useEffect, useMemo, useState } from 'react';

interface LedgerAddFormProps {
  /** Open / close controls live in the parent so the dialog can be
   *  reused for both "add new" and "edit existing". */
  readonly mode: 'add' | 'edit';
  /** The dates already in the ledger — used to:
   *    - reject duplicates on add
   *    - decide whether the form's date will become the *first* entry
   *      (which forces closingPosition to be required) */
  readonly existingDates: readonly string[];
  /** When editing, the row being edited. The dialog pre-fills + treats
   *  date as locked. */
  readonly editing?: LedgerEntry | null;
  readonly onCancel: () => void;
  readonly onSubmit: (entry: LedgerEntry) => Promise<void> | void;
  readonly busy: boolean;
}

const DEFAULT_DATE = (): string => new Date().toISOString().slice(0, 10);

export function LedgerAddForm({
  mode,
  existingDates,
  editing = null,
  onCancel,
  onSubmit,
  busy,
}: LedgerAddFormProps): React.ReactElement {
  const [date, setDate] = useState<string>(editing?.date ?? DEFAULT_DATE());
  const [pnlAmount, setPnlAmount] = useState<string>(editing?.pnlAmount ?? '');
  const [closingPosition, setClosingPosition] = useState<string>(editing?.closingPosition ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [date, pnlAmount, closingPosition]);

  // The candidate becomes the earliest entry when no current entry has a
  // smaller date (or when the ledger is empty).
  const willBeFirst = useMemo(() => {
    if (existingDates.length === 0) return true;
    let minDate = existingDates[0];
    for (const d of existingDates) {
      if (minDate === undefined || d < minDate) minDate = d;
    }
    if (minDate === undefined) return true;
    if (mode === 'edit') {
      // Editing the existing-earliest keeps it earliest.
      if (editing?.date === minDate) return true;
      return date < minDate;
    }
    return date <= minDate;
  }, [existingDates, date, mode, editing]);

  const closingRequired = willBeFirst;

  const handleSubmit = async (): Promise<void> => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError('日期需要 YYYY-MM-DD 格式');
      return;
    }
    if (!/^-?\d+(\.\d+)?$/.test(pnlAmount.trim())) {
      setError('盈亏金额需要是数字（可为负）');
      return;
    }
    const closingTrim = closingPosition.trim();
    if (closingRequired && closingTrim === '') {
      setError('当前条目是首条，必须填写当日收盘仓位');
      return;
    }
    if (closingTrim !== '' && !/^-?\d+(\.\d+)?$/.test(closingTrim)) {
      setError('收盘仓位需要是数字');
      return;
    }
    if (mode === 'add' && existingDates.includes(date)) {
      setError(`日期 ${date} 已存在，请编辑现有条目或换一天`);
      return;
    }
    const entry: LedgerEntry = {
      date,
      pnlAmount: pnlAmount.trim(),
      ...(closingTrim === '' ? {} : { closingPosition: closingTrim }),
    };
    const parsed = LedgerEntrySchema.safeParse(entry);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '校验失败');
      return;
    }
    try {
      await onSubmit(parsed.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Flex
      position="fixed"
      inset="0"
      bg="rgba(15,17,22,0.55)"
      align="center"
      justify="center"
      zIndex={1200}
      onMouseDown={(e): void => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <Box
        bg="panel"
        borderWidth="1px"
        borderColor="line"
        boxShadow="0 14px 48px rgba(0,0,0,0.55)"
        p="16px"
        minW="360px"
        maxW="92vw"
        onMouseDown={(e): void => {
          e.stopPropagation();
        }}
      >
        <Text
          fontSize="11px"
          letterSpacing="0.18em"
          color="accent"
          fontFamily="mono"
          fontWeight="700"
          mb="12px"
        >
          {mode === 'add' ? 'LDG.ADD' : 'LDG.EDIT'}
        </Text>
        <Flex direction="column" gap="10px">
          <Field
            label="日期"
            required
            disabled={mode === 'edit'}
            value={date}
            onChange={setDate}
            placeholder="YYYY-MM-DD"
          />
          <Field
            label="当日盈亏（元）"
            required
            value={pnlAmount}
            onChange={setPnlAmount}
            placeholder="可为负，如 -120.5"
          />
          <Field
            label={`当日收盘仓位${closingRequired ? '（首条必填）' : '（可留空，自动推算）'}`}
            required={closingRequired}
            value={closingPosition}
            onChange={setClosingPosition}
            placeholder={closingRequired ? '如 105000' : '留空 = 前一日 + 当日盈亏'}
          />
          {error !== null && (
            <Text fontSize="11px" color="fall" fontFamily="mono">
              {error}
            </Text>
          )}
          <Flex gap="8px" justify="flex-end" mt="4px">
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
            >
              {mode === 'add' ? '新增' : '保存'}
            </Button>
          </Flex>
        </Flex>
      </Box>
    </Flex>
  );
}

interface FieldProps {
  readonly label: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (next: string) => void;
}

function Field({
  label,
  required = false,
  disabled = false,
  value,
  placeholder,
  onChange,
}: FieldProps): React.ReactElement {
  return (
    <Box>
      <Text fontSize="10px" letterSpacing="0.12em" color="ink3" fontFamily="mono" mb="2px">
        {label}
        {required ? (
          <Text as="span" color="fall" ml="2px">
            *
          </Text>
        ) : null}
      </Text>
      <Input
        size="sm"
        value={value}
        disabled={disabled}
        onChange={(e): void => {
          onChange(e.currentTarget.value);
        }}
        {...(placeholder !== undefined ? { placeholder } : {})}
        bg="panel2"
        fontFamily="mono"
        fontSize="12px"
      />
    </Box>
  );
}
