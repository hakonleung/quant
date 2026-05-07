/**
 * Multi-field form widget. Supports text, number, enum, and search fields.
 *
 * `search` fields show live candidates beneath the input row as the user
 * types. Up/Down moves the candidate cursor; Enter picks the highlighted
 * row (or, if there are no matches, submits the form when the existing
 * value parses).
 *
 * Pure (CLAUDE.md §2.5.1).
 */

import { ANSI, paint } from '../render/ansi.js';
import { renderTable } from '../render/table.js';
import type { CommitResolution, InteractiveWidget, KeyHint, KeySpec, WidgetStep } from './types.js';

export type FormFieldKind = 'text' | 'number' | 'enum' | 'search';

export interface SearchCandidate {
  readonly value: string;
  readonly label: string;
}

export interface FormField {
  readonly key: string;
  readonly label: string;
  readonly kind: FormFieldKind;
  readonly required?: boolean;
  readonly placeholder?: string;
  /** Initial value displayed in the input. */
  readonly initial?: string;
  /** When kind === 'enum'. */
  readonly options?: readonly string[];
  /** When kind === 'search'. Returns up to N candidates for the typed query. */
  readonly search?: (query: string) => readonly SearchCandidate[];
  /** Optional zod-like validator returning an error message or null. */
  readonly validate?: (value: string) => string | null;
  /**
   * Optional suffix shown after the value (gray) — e.g. unit like `%`,
   * `CNY`, `min`. Receives the full form values so the suffix can react
   * to other fields (`abs` value's currency depends on `market`).
   */
  readonly suffix?: (values: FormValues) => string;
}

export type FormValues = Readonly<Record<string, string>>;

export interface FormPromptConfig {
  readonly title: string;
  readonly fields: readonly FormField[];
  readonly onSubmit: (values: FormValues) => CommitResolution;
}

export interface FormState {
  readonly values: Readonly<Record<string, string>>;
  readonly active: number;
  readonly error: string | null;
  /** When the active field is `search`, this is the highlighted candidate row. */
  readonly searchIdx: number;
  /** When the active field is `search`, this is the unconfirmed query buffer. */
  readonly searchQuery: string;
}

const SEARCH_VIEWPORT = 6;

export function formPrompt(cfg: FormPromptConfig): InteractiveWidget<FormState, CommitResolution> {
  const initialValues: Record<string, string> = {};
  for (const f of cfg.fields) initialValues[f.key] = f.initial ?? '';
  const initialState: FormState = {
    values: initialValues,
    active: 0,
    error: null,
    searchIdx: 0,
    searchQuery: cfg.fields[0]?.kind === 'search' ? (cfg.fields[0].initial ?? '') : '',
  };
  return {
    title: cfg.title,
    initialState,
    hints: (s) => buildHints(cfg, s),
    render: (s, w) => renderBody(cfg, s, w),
    snapshot: (s) => snapshotBody(cfg, s),
    handleKey: (s, key) => handleKey(cfg, s, key),
    commit: (resolution) => resolution,
  } as InteractiveWidget<FormState, CommitResolution>;
}

function buildHints(cfg: FormPromptConfig, state: FormState): readonly KeyHint[] {
  const field = cfg.fields[state.active];
  const hints: KeyHint[] = [{ keys: ['↑', '↓'], label: 'field' }];
  if (field?.kind === 'enum') {
    hints.push({ keys: ['←', '→'], label: 'option' });
  } else if (field?.kind === 'search') {
    hints.push({ keys: ['←', '→'], label: 'pick' });
    hints.push({ keys: ['type'], label: 'search' });
  } else {
    hints.push({ keys: ['type'], label: 'edit' });
  }
  hints.push({ keys: ['Enter'], label: field?.kind === 'search' ? 'pick / submit' : 'submit' });
  hints.push({ keys: ['Esc'], label: 'cancel' });
  return hints;
}

/** Width of the label column — labels are padded up to this many cells. */
const LABEL_PAD = 12;

/** 0-based column where this field's value/input begins on its line. */
function valueStartCol(label: string): number {
  // marker(1) + ' '(1) + max(label.length, LABEL_PAD)(N) + ' '(1)
  return 1 + 1 + Math.max(label.length, LABEL_PAD) + 1;
}

function renderBody(cfg: FormPromptConfig, state: FormState, width: number): string {
  const head = paint(cfg.title, ANSI.bold, ANSI.cyan);
  const lines: string[] = [head];
  let activeLineIdx = -1;

  cfg.fields.forEach((f, i) => {
    if (i === state.active) activeLineIdx = lines.length;
    lines.push(renderField(f, state, i === state.active));
    if (i === state.active && f.kind === 'search' && f.search !== undefined) {
      const matches = f.search(state.searchQuery).slice(0, SEARCH_VIEWPORT);
      if (matches.length === 0 && state.searchQuery.length > 0) {
        lines.push(`    ${paint('no matches', ANSI.gray)}`);
      } else if (matches.length > 0) {
        const idx = Math.min(state.searchIdx, matches.length - 1);
        const rows = matches.map((m, j) => ({ marker: j === idx ? '▸' : ' ', label: m.label }));
        const table = renderTable(
          rows as unknown as readonly Record<string, unknown>[],
          [
            { key: 'marker', header: '', max: 2 },
            { key: 'label', header: '', max: Math.max(20, Math.min(60, width - 8)) },
          ],
          { header: false, highlightRow: idx, gap: 1 },
        );
        // Push each table row as its own line entry so totalRows == lines.length
        // — needed for cursor-back math below.
        for (const l of table.split('\n')) lines.push(`    ${l}`);
      }
    }
  });
  if (state.error !== null) lines.push(paint(`! ${state.error}`, ANSI.red));

  const body = lines.join('\n');
  return body + cursorEscape(cfg, state, lines.length, activeLineIdx);
}

/**
 * Place the cursor at the end of the active field's input position. Without
 * this, after the body is written xterm leaves the cursor on the last row,
 * which is jarring when typing into a `code` search or `value` number that
 * isn't the last field. The escape moves the cursor up to the active row
 * and across to `valueStartCol(label) + length(typed)`.
 *
 * For `enum` fields (which are picked with arrow keys, not typed) the
 * cursor is hidden via DECTCEM (`\x1b[?25l`); the bridge re-enables it
 * before painting the next text-input footer.
 */
function cursorEscape(
  cfg: FormPromptConfig,
  state: FormState,
  totalRows: number,
  activeLineIdx: number,
): string {
  if (activeLineIdx < 0) return '\x1b[?25l';
  const field = cfg.fields[state.active];
  if (field === undefined) return '\x1b[?25l';
  if (field.kind === 'enum') return '\x1b[?25l';
  const typed = field.kind === 'search' ? state.searchQuery : (state.values[field.key] ?? '');
  const col1based = valueStartCol(field.label) + typed.length + 1;
  const rowsUp = Math.max(0, totalRows - 1 - activeLineIdx);
  // CSI <n>F = cursor previous line (n) and to col 1; CSI <n>G = absolute
  // column. `\r` instead of `\x1b[0F` keeps the move within the current row
  // when there's no row offset.
  const upPart = rowsUp > 0 ? `\x1b[${String(rowsUp)}F` : '\r';
  return `\x1b[?25h${upPart}\x1b[${String(col1based)}G`;
}

function renderField(field: FormField, state: FormState, active: boolean): string {
  const marker = active ? paint('▸', ANSI.cyan, ANSI.bold) : ' ';
  const label = paint(field.label.padEnd(LABEL_PAD), active ? ANSI.bold : ANSI.gray);
  const value = state.values[field.key] ?? '';
  if (field.kind === 'enum') {
    const opts = (field.options ?? []).map((o) =>
      o === value ? paint(`[${o}]`, ANSI.cyan, ANSI.bold) : paint(o, ANSI.gray),
    );
    return `${marker} ${label} ${opts.join(' ')}`;
  }
  if (field.kind === 'search' && active) {
    const q = state.searchQuery;
    const display =
      q.length === 0
        ? paint(field.placeholder ?? 'type to search', ANSI.gray)
        : paint(q, ANSI.bold);
    const committed =
      value.length > 0 && value !== q ? paint(`  (selected: ${value})`, ANSI.gray) : '';
    return `${marker} ${label} ${display}${committed}`;
  }
  const display =
    value.length === 0
      ? paint(field.placeholder ?? '<empty>', ANSI.gray)
      : paint(value, active ? ANSI.bold : ANSI.white);
  const suffix =
    field.suffix !== undefined ? paint(` ${field.suffix(state.values)}`, ANSI.gray) : '';
  return `${marker} ${label} ${display}${suffix}`;
}

function snapshotBody(cfg: FormPromptConfig, state: FormState): string {
  return cfg.fields.map((f) => `${f.label}=${state.values[f.key] ?? ''}`).join('  ');
}

function handleKey(
  cfg: FormPromptConfig,
  state: FormState,
  key: KeySpec,
): WidgetStep<FormState, CommitResolution> {
  const field = cfg.fields[state.active];
  if (field === undefined) return { kind: 'state', next: state };

  if (key.special === 'Up') return moveActive(cfg, state, -1);
  if (key.special === 'Down') return moveActive(cfg, state, 1);
  if (key.special === 'Tab') return moveActive(cfg, state, 1);
  if (key.special === 'ShiftTab') return moveActive(cfg, state, -1);

  if (field.kind === 'enum') {
    if (key.special === 'Left' || key.special === 'Right') {
      return cycleEnum(field, state, key.special === 'Right' ? 1 : -1);
    }
    if (key.special === 'Enter') return submit(cfg, state);
    return { kind: 'state', next: state };
  }

  if (field.kind === 'search') {
    return handleSearchKey(cfg, field, state, key);
  }

  if (key.special === 'Enter') return submit(cfg, state);
  if (key.special === 'Backspace') {
    const cur = state.values[field.key] ?? '';
    return setValue(state, field.key, cur.slice(0, -1));
  }
  if (key.text !== undefined) {
    if (field.kind === 'number' && !/^[0-9.\-]$/u.test(key.text) && key.text.length === 1) {
      return { kind: 'state', next: state };
    }
    const cur = state.values[field.key] ?? '';
    return setValue(state, field.key, cur + key.text);
  }
  return { kind: 'state', next: state };
}

function handleSearchKey(
  cfg: FormPromptConfig,
  field: FormField,
  state: FormState,
  key: KeySpec,
): WidgetStep<FormState, CommitResolution> {
  const matches = field.search?.(state.searchQuery) ?? [];
  if (key.special === 'Left') {
    return {
      kind: 'state',
      next: { ...state, searchIdx: Math.max(0, state.searchIdx - 1) },
    };
  }
  if (key.special === 'Right') {
    return {
      kind: 'state',
      next: { ...state, searchIdx: Math.min(Math.max(0, matches.length - 1), state.searchIdx + 1) },
    };
  }
  if (key.special === 'Enter') {
    if (matches.length > 0) {
      const pick = matches[Math.min(state.searchIdx, matches.length - 1)] as SearchCandidate;
      // Commit the pick to the field value, advance to next field if any.
      const committed: FormState = {
        ...state,
        values: { ...state.values, [field.key]: pick.value },
        searchQuery: pick.value,
        error: null,
      };
      // If this is the last field with no more search → submit.
      if (state.active === cfg.fields.length - 1) {
        return submit(cfg, committed);
      }
      return moveActive(cfg, committed, 1);
    }
    // No matches but value already committed → try submit.
    return submit(cfg, state);
  }
  if (key.special === 'Backspace') {
    const q = state.searchQuery.slice(0, -1);
    return {
      kind: 'state',
      next: { ...state, searchQuery: q, values: { ...state.values, [field.key]: q }, searchIdx: 0 },
    };
  }
  if (key.text !== undefined) {
    const q = state.searchQuery + key.text;
    return {
      kind: 'state',
      next: { ...state, searchQuery: q, values: { ...state.values, [field.key]: q }, searchIdx: 0 },
    };
  }
  return { kind: 'state', next: state };
}

function moveActive(
  cfg: FormPromptConfig,
  state: FormState,
  delta: number,
): WidgetStep<FormState, CommitResolution> {
  const count = cfg.fields.length;
  const next = (state.active + delta + count) % count;
  const nextField = cfg.fields[next];
  const nextSearchQuery = nextField?.kind === 'search' ? (state.values[nextField.key] ?? '') : '';
  return {
    kind: 'state',
    next: { ...state, active: next, error: null, searchIdx: 0, searchQuery: nextSearchQuery },
  };
}

function cycleEnum(
  field: FormField,
  state: FormState,
  delta: number,
): WidgetStep<FormState, CommitResolution> {
  const opts = field.options ?? [];
  if (opts.length === 0) return { kind: 'state', next: state };
  const cur = state.values[field.key] ?? opts[0]!;
  const idx = opts.indexOf(cur);
  const nextIdx = (idx + delta + opts.length) % opts.length;
  return setValue(state, field.key, opts[nextIdx] ?? cur);
}

function setValue(
  state: FormState,
  key: string,
  value: string,
): WidgetStep<FormState, CommitResolution> {
  return {
    kind: 'state',
    next: { ...state, values: { ...state.values, [key]: value }, error: null },
  };
}

function submit(cfg: FormPromptConfig, state: FormState): WidgetStep<FormState, CommitResolution> {
  for (const f of cfg.fields) {
    const v = state.values[f.key] ?? '';
    if ((f.required ?? true) && v.length === 0) {
      return { kind: 'state', next: { ...state, error: `${f.label} is required` } };
    }
    if (f.validate !== undefined) {
      const err = f.validate(v);
      if (err !== null) return { kind: 'state', next: { ...state, error: err } };
    }
  }
  return { kind: 'submit', result: cfg.onSubmit(state.values) };
}
