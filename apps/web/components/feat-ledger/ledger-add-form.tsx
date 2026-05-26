'use client';

import { Box, Button, Flex, Input, Text } from '@chakra-ui/react';
import { DialogPortal } from '../feat-view/dialog-portal.js';
import { LedgerEntrySchema, type LedgerEntry } from '@quant/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useFocusTrap } from '../../lib/fp/use-focus-trap.js';
import { useViewport } from '../../lib/hooks/use-viewport.js';

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

interface FormState {
  readonly date: string;
  readonly pnlAmount: string;
  readonly closingPosition: string;
}

const DEFAULT_DATE = (): string => new Date().toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUM_RE = /^-?\d+(\.\d+)?$/;

interface ValidationCtx {
  readonly mode: 'add' | 'edit';
  readonly existingDates: readonly string[];
  readonly closingRequired: boolean;
}

/**
 * Pure validation — splits into a string-shape check and a schema
 * check so each helper stays inside the cyclomatic-complexity limit.
 * Returns either a user-facing error message or the parsed entry.
 */
function validateEntry(
  state: FormState,
  ctx: ValidationCtx,
): { readonly entry: LedgerEntry } | { readonly error: string } {
  const shape = validateShape(state, ctx);
  if (shape !== null) return { error: shape };
  const closingTrim = state.closingPosition.trim();
  const candidate: LedgerEntry = {
    date: state.date,
    pnlAmount: state.pnlAmount.trim(),
    ...(closingTrim === '' ? {} : { closingPosition: closingTrim }),
  };
  const parsed = LedgerEntrySchema.safeParse(candidate);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? '校验失败' };
  return { entry: parsed.data };
}

/** First-pass shape check — only fast regex / membership tests. Keeps
 *  validateEntry's cyclomatic complexity under the limit. */
function validateShape(state: FormState, ctx: ValidationCtx): string | null {
  const { date, pnlAmount, closingPosition } = state;
  if (!DATE_RE.test(date)) return '日期需要 YYYY-MM-DD 格式';
  if (!NUM_RE.test(pnlAmount.trim())) return '盈亏金额需要是数字（可为负）';
  const closingTrim = closingPosition.trim();
  if (ctx.closingRequired && closingTrim === '') return '当前条目是首条，必须填写当日收盘仓位';
  if (closingTrim !== '' && !NUM_RE.test(closingTrim)) return '收盘仓位需要是数字';
  if (ctx.mode === 'add' && ctx.existingDates.includes(date))
    return `日期 ${date} 已存在，请编辑现有条目或换一天`;
  return null;
}

function useFirstEntryFlag(
  date: string,
  existingDates: readonly string[],
  mode: 'add' | 'edit',
  editing: LedgerEntry | null,
): boolean {
  return useMemo(() => {
    if (existingDates.length === 0) return true;
    let minDate: string | undefined;
    for (const d of existingDates) {
      if (minDate === undefined || d < minDate) minDate = d;
    }
    if (minDate === undefined) return true;
    if (mode === 'edit') {
      if (editing?.date === minDate) return true;
      return date < minDate;
    }
    return date <= minDate;
  }, [existingDates, date, mode, editing]);
}

/** Esc closes the dialog regardless of which field has focus — same
 *  convention as the FeatView fullscreen toggle. */
function useEscClose(onCancel: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);
}

export function LedgerAddForm({
  mode,
  existingDates,
  editing = null,
  onCancel,
  onSubmit,
  busy,
}: LedgerAddFormProps): React.ReactElement {
  const { mode: vpMode } = useViewport();
  const isMobile = vpMode === 'mobile';
  const [state, setState] = useState<FormState>({
    date: editing?.date ?? DEFAULT_DATE(),
    pnlAmount: editing?.pnlAmount ?? '',
    closingPosition: editing?.closingPosition ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);
  useEscClose(onCancel);
  useEffect(() => {
    setError(null);
  }, [state]);

  const closingRequired = useFirstEntryFlag(state.date, existingDates, mode, editing);
  const handleSubmit = useCallback(async (): Promise<void> => {
    const result = validateEntry(state, { mode, existingDates, closingRequired });
    if ('error' in result) {
      setError(result.error);
      return;
    }
    try {
      await onSubmit(result.entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [state, mode, existingDates, closingRequired, onSubmit]);

  return (
    <DialogShell
      ref={dialogRef}
      isMobile={isMobile}
      title={mode === 'add' ? 'LDG.ADD' : 'LDG.EDIT'}
      ariaLabel={mode === 'add' ? '新增账本条目' : '编辑账本条目'}
      onOutsideClose={isMobile ? null : onCancel}
    >
      <FormFields state={state} onChange={setState} mode={mode} closingRequired={closingRequired} />
      {error !== null && (
        <Text fontSize="xs" color="fall" fontFamily="mono" role="alert">
          {error}
        </Text>
      )}
      <Box flex="1" />
      <DialogActions
        isMobile={isMobile}
        busy={busy}
        confirmLabel={mode === 'add' ? '新增' : '保存'}
        onCancel={onCancel}
        onConfirm={(): void => {
          void handleSubmit();
        }}
      />
    </DialogShell>
  );
}

interface DialogShellProps {
  readonly ref: React.Ref<HTMLDivElement>;
  readonly isMobile: boolean;
  readonly title: string;
  readonly ariaLabel: string;
  /** When non-null, clicking the scrim cancels the dialog. Mobile
   *  full-bleed sheet has no scrim, so this is null there. */
  readonly onOutsideClose: (() => void) | null;
  readonly children: ReactNode;
}

const SCRIM_SAFE_AREA = {
  paddingTop: 'env(safe-area-inset-top)',
  paddingBottom: 'env(safe-area-inset-bottom)',
} as const;

function DialogShell({
  ref,
  isMobile,
  title,
  ariaLabel,
  onOutsideClose,
  children,
}: DialogShellProps): React.ReactElement {
  return (
    <DialogPortal>
      <Flex
      position="fixed"
      inset="0"
      bg="overlay"
      align={isMobile ? 'stretch' : 'center'}
      justify="center"
      zIndex="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      style={SCRIM_SAFE_AREA}
      onMouseDown={(e): void => {
        if (onOutsideClose !== null && e.target === e.currentTarget) onOutsideClose();
      }}
    >
      <DialogCard ref={ref} isMobile={isMobile} title={title}>
        {children}
      </DialogCard>
    </Flex>
    </DialogPortal>
  );
}

interface DialogCardProps {
  readonly ref: React.Ref<HTMLDivElement>;
  readonly isMobile: boolean;
  readonly title: string;
  readonly children: ReactNode;
}

function DialogCard({ ref, isMobile, title, children }: DialogCardProps): React.ReactElement {
  const cardStyle = isMobile
    ? { w: '100vw', h: '100dvh', minW: 'unset', maxW: 'unset', p: '20px' }
    : { minW: '360px', maxW: '92vw', p: '16px' };
  return (
    <Box
      ref={ref}
      bg="panel"
      borderWidth={isMobile ? '0' : '1px'}
      borderColor="line"
      boxShadow={isMobile ? 'none' : 'shadowCard'}
      display="flex"
      flexDirection="column"
      overflow="auto"
      {...cardStyle}
      onMouseDown={(e): void => {
        e.stopPropagation();
      }}
    >
      <Text
        fontSize="xs"
        letterSpacing="0.18em"
        color="accent"
        fontFamily="mono"
        fontWeight="700"
        mb="12px"
      >
        {title}
      </Text>
      <Flex direction="column" gap="10px" flex="1" minH={0}>
        {children}
      </Flex>
    </Box>
  );
}

interface FormFieldsProps {
  readonly state: FormState;
  readonly onChange: (next: FormState) => void;
  readonly mode: 'add' | 'edit';
  readonly closingRequired: boolean;
}

function FormFields({
  state,
  onChange,
  mode,
  closingRequired,
}: FormFieldsProps): React.ReactElement {
  const closingLabel = `当日收盘仓位${closingRequired ? '（首条必填）' : '（可留空，自动推算）'}`;
  const closingPlaceholder = closingRequired ? '如 105000' : '留空 = 前一日 + 当日盈亏';
  return (
    <>
      <Field
        label="日期"
        required
        disabled={mode === 'edit'}
        value={state.date}
        onChange={(date): void => {
          onChange({ ...state, date });
        }}
        placeholder="YYYY-MM-DD"
        type="date"
      />
      <Field
        label="当日盈亏（元）"
        required
        value={state.pnlAmount}
        onChange={(pnlAmount): void => {
          onChange({ ...state, pnlAmount });
        }}
        placeholder="可为负,如 -120.5"
        inputMode="decimal"
      />
      <Field
        label={closingLabel}
        required={closingRequired}
        value={state.closingPosition}
        onChange={(closingPosition): void => {
          onChange({ ...state, closingPosition });
        }}
        placeholder={closingPlaceholder}
        inputMode="decimal"
      />
    </>
  );
}

interface DialogActionsProps {
  readonly isMobile: boolean;
  readonly busy: boolean;
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

function DialogActions({
  isMobile,
  busy,
  confirmLabel,
  onCancel,
  onConfirm,
}: DialogActionsProps): React.ReactElement {
  const size = isMobile ? 'sm' : 'xs';
  return (
    <Flex gap="8px" justify="flex-end" mt="4px" flexWrap="wrap">
      <Button size={size} variant="outline" onClick={onCancel} disabled={busy}>
        取消
      </Button>
      <Button size={size} colorPalette="accent" onClick={onConfirm} loading={busy}>
        {confirmLabel}
      </Button>
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
  /** Native `<input type>` — `'date'` triggers the OS date picker on
   *  mobile (iOS scroller / Android calendar). */
  readonly type?: 'text' | 'date';
  /** `inputMode='decimal'` surfaces a numeric keypad on mobile while
   *  still letting the user type a leading minus sign for negative
   *  PnL values. */
  readonly inputMode?: 'decimal';
}

function Field({
  label,
  required = false,
  disabled = false,
  value,
  placeholder,
  onChange,
  type = 'text',
  inputMode,
}: FieldProps): React.ReactElement {
  return (
    <Box>
      <Text fontSize="xs" letterSpacing="0.12em" color="ink3" fontFamily="mono" mb="2px">
        {label}
        {required ? (
          <Text as="span" color="fall" ml="2px">
            *
          </Text>
        ) : null}
      </Text>
      <Input
        size="sm"
        type={type}
        value={value}
        disabled={disabled}
        onChange={(e): void => {
          onChange(e.currentTarget.value);
        }}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(inputMode !== undefined ? { inputMode } : {})}
        bg="panel3"
        fontFamily="mono"
        fontSize="sm"
      />
    </Box>
  );
}
