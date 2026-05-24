'use client';

/**
 * React glue between xterm.js and the engine reducer — generalised over
 * font-size / banner / auto-run from `feat-term-main/use-terminal.ts`.
 * See that file for the painting model commentary; the logic here is
 * identical, only the host-config knobs are lifted out.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import {
  ANSI,
  buildStockIndex,
  complete,
  EMPTY_STOCK_INDEX,
  fromBrowserEvent,
  getRunner,
  initialState,
  paint,
  reduce,
  stockListAction,
  stripAnsi,
  toKeySpec,
  type CommandCtx,
  type Effect,
  type Event,
  type StockIndex,
  type TerminalState,
} from '@quant/terminal';

import { useQueryClient } from '@tanstack/react-query';

import { parseTrailingCursorUp } from '../../lib/fp/parse-trailing-cursor-up.js';
import { buildCompleterEnv } from '../../lib/instructions/completion.js';
import { defaultInvoker } from '../../lib/instructions/fe-center.js';
import { feDispatch, termOutputToEvents } from '../../lib/instructions/dispatch.js';
import type { FeCtx } from '../../lib/instructions/fe-types.js';
import { useUiStore } from '../../lib/stores/ui.store.js';
import { installRunner } from '../../lib/term/install-runner.js';

const PROMPT = paint('$ ', ANSI.cyan, ANSI.bold);
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

interface RenderMem {
  committedHistory: number;
  footerRows: number;
  cursorUpFromBottom: number;
  initial: boolean;
  spinnerTick: number;
}

export type InitialOutputStatus = 'ok' | 'cached' | 'err' | 'info';

export interface InitialOutput {
  readonly body: string;
  readonly status: InitialOutputStatus;
}

export interface UseTermConsoleConfig {
  readonly fontSize: number;
  readonly banner: string;
  /**
   * Steal keyboard focus on mount. Required for full-screen surfaces
   * (TERM.MAIN) where the terminal IS the page. Must be false for panes
   * embedded alongside other interactive widgets — otherwise the xterm
   * helper textarea hijacks every keystroke from neighbouring features
   * (MKT search etc.). Default: false.
   */
  readonly autoFocus?: boolean;
  /**
   * Optional initial command-line buffer. Pre-filled — NOT executed.
   * The user presses Enter to submit. Use for "no cache — let the
   * operator confirm" surfaces.
   */
  readonly initialBuffer?: string;
  /**
   * Optional pre-rendered cached result. Injected as a history `output`
   * entry on mount with no command run. Use for the "we already have a
   * cache, paint it" surface.
   */
  readonly initialOutput?: InitialOutput;
}

export interface TermConsoleBridge {
  readonly mount: (host: HTMLDivElement) => void;
  readonly unmount: () => void;
  readonly runCommand: (line: string) => void;
  readonly focus: () => void;
  readonly state: TerminalState;
  /** Live xterm instance — null until `mount()` has been called. */
  readonly termRef: React.MutableRefObject<Terminal | null>;
}

export function useTermConsole(config: UseTermConsoleConfig): TermConsoleBridge {
  const [state, setState] = useState<TerminalState>(initialState);
  const stateRef = useRef<TerminalState>(state);
  stateRef.current = state;

  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const indexRef = useRef<StockIndex>(EMPTY_STOCK_INDEX);
  const abortRef = useRef<AbortController | null>(null);
  const memRef = useRef<RenderMem>({
    committedHistory: 0,
    footerRows: 0,
    cursorUpFromBottom: 0,
    initial: true,
    spinnerTick: 0,
  });
  const paintScheduledRef = useRef<boolean>(false);
  const spinnerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialAppliedRef = useRef<boolean>(false);

  const queryClient = useQueryClient();

  const revalidateRef = useRef<((scope: import('@quant/terminal').RevalidateScope) => void) | null>(
    null,
  );

  const ctxStores = useMemo(
    () => ({
      ui: {
        getFocusCode: (): string | null => useUiStore.getState().focusCode,
        setFocusCode: (code: string | null): void => useUiStore.getState().setFocusCode(code),
      },
      revalidate: (scope: import('@quant/terminal').RevalidateScope): void => {
        revalidateRef.current?.(scope);
      },
    }),
    [],
  );

  const dispatchRef = useRef<((ev: Event) => void) | null>(null);

  const buildCtx = useCallback((): CommandCtx => {
    const ac = new AbortController();
    abortRef.current = ac;
    return {
      actions: getRunner(),
      stockIndex: indexRef.current,
      stores: ctxStores,
      signal: ac.signal,
      dispatchEvent: (ev: Event): void => {
        dispatchRef.current?.(ev);
      },
    };
  }, [ctxStores]);

  const schedulePaint = useCallback((): void => {
    if (paintScheduledRef.current) return;
    paintScheduledRef.current = true;
    queueMicrotask(() => {
      paintScheduledRef.current = false;
      paintTerminal(
        termRef.current,
        stateRef.current,
        memRef.current,
        useUiStore.getState().focusCode,
      );
    });
  }, []);

  const dispatch = useCallback(
    (ev: Event): void => {
      const r = reduce(stateRef.current, ev);
      stateRef.current = r.state;
      setState(r.state);
      for (const eff of r.effects) {
        applyEffect(eff);
      }
      schedulePaint();
    },
    // applyEffect closes over schedulePaint; we intentionally exclude it
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schedulePaint],
  );
  dispatchRef.current = dispatch;

  const applyEffect = useCallback(
    (eff: Effect): void => {
      if (eff.kind === 'runCommand') {
        const baseCtx = buildCtx();
        const feCtx: FeCtx = { ...baseCtx, api: defaultInvoker };
        void feDispatch(eff.line, feCtx).then((out) => {
          for (const ev of termOutputToEvents(out)) dispatch(ev);
        });
        return;
      }
      if (eff.kind === 'commitWidget') {
        if (eff.resolution.kind === 'command') {
          dispatch({ kind: 'submit', line: eff.resolution.line });
        } else if (eff.resolution.kind === 'widget') {
          dispatch({ kind: 'startInteractive', widget: eff.resolution.next });
        } else if (eff.resolution.kind === 'output') {
          dispatch({ kind: 'result', entry: eff.resolution.entry });
        }
        return;
      }
      if (eff.kind === 'abort') {
        abortRef.current?.abort();
        return;
      }
      if (eff.kind === 'completionRequested') {
        applyCompletion();
      }
    },
    [buildCtx, dispatch /* applyCompletion */],
  );

  const applyCompletion = useCallback((): void => {
    const cur = stateRef.current;
    const env = buildCompleterEnv(indexRef.current);
    const r = complete(cur.buffer, cur.cursor, env);
    if (r.candidates.length === 0) return;
    const fragmentText = cur.buffer.slice(r.tokenStart, r.tokenEnd);
    if (r.candidates.length === 1) {
      const ins = r.candidates[0]!.insert;
      const next = cur.buffer.slice(0, r.tokenStart) + ins + ' ' + cur.buffer.slice(r.tokenEnd);
      const cursor = r.tokenStart + ins.length + 1;
      dispatch({ kind: 'setBuffer', buffer: next, cursor });
      return;
    }
    if (r.commonPrefix.length > fragmentText.length) {
      const next =
        cur.buffer.slice(0, r.tokenStart) + r.commonPrefix + cur.buffer.slice(r.tokenEnd);
      const cursor = r.tokenStart + r.commonPrefix.length;
      dispatch({ kind: 'setBuffer', buffer: next, cursor });
      return;
    }
    dispatch({
      kind: 'setCandidates',
      candidates: r.candidates.map((c) => c.label).slice(0, 16),
    });
  }, [buildCtx, dispatch]);

  const observerRef = useRef<ResizeObserver | null>(null);

  const mount = useCallback(
    (host: HTMLDivElement): void => {
      if (termRef.current !== null) {
        try {
          termRef.current.dispose();
        } catch {
          /* */
        }
        termRef.current = null;
      }
      const term = new Terminal({
        fontFamily:
          '"Monaspace Neon", "Monaspace Krypton", "Monaspace Argon", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
        fontSize: config.fontSize,
        letterSpacing: 0,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        cursorWidth: 2,
        convertEol: true,
        scrollback: 1000,
        theme: {
          background: '#06080a',
          foreground: '#cfead8',
          cursor: '#5eff9c',
          cursorAccent: '#06080a',
          selectionBackground: '#1f8a4f',
          black: '#0a0e10',
          red: '#ff4d6d',
          green: '#5eff9c',
          yellow: '#ffc14d',
          blue: '#5cf2ff',
          magenta: '#ff5cd1',
          cyan: '#5cf2ff',
          white: '#cfead8',
          brightBlack: '#4d6c61',
          brightRed: '#ff4d6d',
          brightGreen: '#5eff9c',
          brightYellow: '#ffc14d',
          brightBlue: '#5cf2ff',
          brightMagenta: '#ff5cd1',
          brightCyan: '#5cf2ff',
          brightWhite: '#ffffff',
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      try {
        fit.fit();
      } catch {
        /* */
      }
      term.onData((data) => {
        const key = toKeySpec(data);
        if (key.special !== undefined || key.text !== undefined) {
          dispatch({ kind: 'key', key });
        }
      });
      term.attachCustomKeyEventHandler((ev) => {
        const key = fromBrowserEvent(ev);
        if (key === null) return true;
        ev.preventDefault();
        dispatch({ kind: 'key', key });
        return false;
      });
      termRef.current = term;
      fitRef.current = fit;
      memRef.current = {
        committedHistory: 0,
        footerRows: 0,
        cursorUpFromBottom: 0,
        initial: true,
        spinnerTick: 0,
      };

      const installed = installRunner({
        lookupName: (code) => indexRef.current.byCode(code)?.name ?? null,
        queryClient,
      });
      const { kind } = installed;
      revalidateRef.current = installed.revalidate;

      if (config.banner.length > 0) {
        const banner =
          kind === 'mock' ? `${config.banner} · MOCK runner` : config.banner;
        term.writeln(paint(banner, ANSI.gray));
      }
      paintTerminal(term, stateRef.current, memRef.current, useUiStore.getState().focusCode);
      if (config.autoFocus === true) {
        try {
          term.focus();
        } catch {
          /* */
        }
      }

      void preloadIndex(indexRef);

      if (!initialAppliedRef.current) {
        initialAppliedRef.current = true;
        const initialOutput = config.initialOutput;
        const initialBuffer = config.initialBuffer;
        // Defer to a microtask so xterm's initial paint has committed
        // the empty prompt line before we inject history / buffer.
        queueMicrotask(() => {
          if (initialOutput !== undefined) {
            dispatch({
              kind: 'result',
              entry: { status: initialOutput.status, body: initialOutput.body },
            });
          }
          if (initialBuffer !== undefined && initialBuffer.length > 0) {
            dispatch({ kind: 'setBuffer', buffer: initialBuffer, cursor: initialBuffer.length });
          }
          // Cached output can be many rows; xterm auto-follows the
          // cursor and parks the viewport at the bottom. Surfaces like
          // AI.EQ / AI.SEC remount via `key={code|sectorId}` whenever
          // the focused stock / sector changes, so snapping to the top
          // here is the user-facing "scroll to top on focus change".
          // Sequencing: dispatch's `schedulePaint` queued a microtask
          // that will fire `paintTerminal` (which calls `term.write`
          // many times — each goes through xterm's async parser).
          // Queue an empty write *after* that paint microtask; its
          // callback fires once the parser has drained every preceding
          // write, so scrolling to top happens after the content is in
          // the buffer and not before.
          if (initialOutput !== undefined) {
            queueMicrotask(() => {
              const t = termRef.current;
              if (t === null) return;
              t.write('', () => {
                try {
                  t.scrollToTop();
                } catch {
                  /* */
                }
              });
            });
          }
        });
      }

      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* */
        }
        schedulePaint();
      });
      ro.observe(host);
      observerRef.current = ro;
    },
    [
      dispatch,
      schedulePaint,
      queryClient,
      config.fontSize,
      config.banner,
      config.autoFocus,
      config.initialBuffer,
      config.initialOutput,
    ],
  );

  const unmount = useCallback((): void => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
  }, []);

  const runCommand = useCallback(
    (line: string): void => {
      if (line.length === 0) return;
      dispatch({ kind: 'submit', line });
    },
    [dispatch],
  );

  const focus = useCallback((): void => {
    try {
      termRef.current?.focus();
    } catch {
      /* */
    }
  }, []);

  useEffect(() => {
    const unsub = useUiStore.subscribe((s, prev) => {
      if (s.focusCode !== prev.focusCode) schedulePaint();
    });
    return () => {
      unsub();
    };
  }, [schedulePaint]);

  useEffect(() => {
    const animating = state.phase === 'running' || state.phase === 'cancelling';
    if (animating && spinnerTimerRef.current === null) {
      spinnerTimerRef.current = setInterval(() => {
        memRef.current.spinnerTick = (memRef.current.spinnerTick + 1) % SPINNER_FRAMES.length;
        schedulePaint();
      }, 80);
    } else if (!animating && spinnerTimerRef.current !== null) {
      clearInterval(spinnerTimerRef.current);
      spinnerTimerRef.current = null;
    }
    return () => {
      if (spinnerTimerRef.current !== null) {
        clearInterval(spinnerTimerRef.current);
        spinnerTimerRef.current = null;
      }
    };
  }, [state.phase, schedulePaint]);

  return useMemo<TermConsoleBridge>(
    () => ({ mount, unmount, runCommand, focus, state, termRef }),
    [mount, unmount, runCommand, focus, state],
  );
}

async function preloadIndex(ref: React.MutableRefObject<StockIndex>): Promise<void> {
  try {
    const ac = new AbortController();
    const r = await getRunner().run(stockListAction, {}, { signal: ac.signal });
    ref.current = buildStockIndex(
      r.data as readonly Parameters<typeof buildStockIndex>[0][number][],
    );
  } catch {
    /* */
  }
}

/* ---------- incremental rendering (verbatim from feat-term-main) ---------- */

function paintTerminal(
  term: Terminal | null,
  state: TerminalState,
  mem: RenderMem,
  _focusCode: string | null,
): void {
  if (term === null) return;

  const histShrunk = state.history.length < mem.committedHistory;
  if (histShrunk) {
    term.clear();
    term.write('\x1b[2J\x1b[H');
    mem.committedHistory = 0;
    mem.footerRows = 0;
    mem.cursorUpFromBottom = 0;
    mem.initial = true;
  }

  if (!mem.initial && mem.footerRows > 0) {
    if (mem.cursorUpFromBottom > 0) {
      term.write(`\x1b[${String(mem.cursorUpFromBottom)}B`);
    }
    if (mem.footerRows > 1) {
      term.write(`\x1b[${String(mem.footerRows - 1)}A`);
    }
    term.write('\r\x1b[J');
  } else if (mem.initial) {
    term.write('\r\x1b[J');
    mem.initial = false;
  }

  while (mem.committedHistory < state.history.length) {
    const entry = state.history[mem.committedHistory];
    if (entry !== undefined) writeHistoryEntry(term, entry);
    mem.committedHistory += 1;
  }

  term.write('\x1b[?25h');
  const footer = renderFooter(term, state, mem);
  if (footer.length > 0) {
    term.write(footer);
    mem.footerRows = countWrappedRows(footer, term.cols);
    mem.cursorUpFromBottom = parseTrailingCursorUp(footer);
  } else {
    mem.footerRows = 0;
    mem.cursorUpFromBottom = 0;
  }
}

function writeHistoryEntry(term: Terminal, entry: TerminalState['history'][number]): void {
  if (entry.kind === 'prompt') {
    term.writeln(`${PROMPT}${entry.text}`);
    return;
  }
  if (entry.kind === 'output') {
    const tag = statusTag(entry.status);
    const body = entry.body.length === 0 ? '' : ` ${entry.body}`;
    term.writeln(`${tag}${body}`);
    return;
  }
  term.writeln(paint(`╭ ${entry.title}`, ANSI.gray));
  for (const line of entry.body.split('\n')) {
    term.writeln(`${paint('│', ANSI.gray)} ${line}`);
  }
  term.writeln(paint('╰', ANSI.gray));
}

function renderFooter(term: Terminal, state: TerminalState, mem: RenderMem): string {
  const cols = term.cols;
  const spin = SPINNER_FRAMES[mem.spinnerTick % SPINNER_FRAMES.length] ?? '·';

  if (state.phase === 'interactive' && state.active !== null) {
    return state.active.widget.render(state.active.state, cols, term.rows);
  }
  if (state.phase === 'cancelling') {
    return paint(`${spin} cancelling…`, ANSI.yellow);
  }
  if (state.phase === 'running') {
    const cmd = state.buffer.length > 0 ? state.buffer : '…';
    return (
      paint(`${spin} `, ANSI.brightCyan) +
      paint(`${PROMPT}${cmd}`, ANSI.dim) +
      paint('  fetching', ANSI.gray)
    );
  }
  const tail =
    state.cursor < state.buffer.length ? `\x1b[${String(state.buffer.length - state.cursor)}D` : '';
  const promptLine = `${PROMPT}${state.buffer}${tail}`;
  if (state.candidates.length > 0) {
    const list = state.candidates.map((c) => paint(c, ANSI.gray)).join(paint(' · ', ANSI.gray));
    return `${list}\n${promptLine}`;
  }
  return promptLine;
}

function countWrappedRows(text: string, cols: number): number {
  const lines = text.split('\n');
  let rows = 0;
  for (const ln of lines) {
    const visible = stripAnsi(ln);
    rows += Math.max(1, Math.ceil(visible.length / Math.max(1, cols)));
  }
  return rows;
}

function statusTag(status: 'ok' | 'err' | 'cached' | 'info'): string {
  switch (status) {
    case 'ok':
      return paint('[ok]', ANSI.green, ANSI.bold);
    case 'err':
      return paint('[err]', ANSI.red, ANSI.bold);
    case 'cached':
      return paint('[cached]', ANSI.gray, ANSI.bold);
    case 'info':
      return paint('[info]', ANSI.cyan, ANSI.bold);
    default:
      return '';
  }
}
