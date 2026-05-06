'use client';

/**
 * React glue between xterm.js and the engine reducer.
 *
 * Painting model — designed to eliminate flicker and stale renders:
 *
 *  - The xterm scrollback is treated as **append-only** for permanent
 *    history entries (prompts, outputs, frozen widget snapshots). Each
 *    new entry is written exactly once.
 *  - The "footer" — current prompt line(s) or the active interactive
 *    widget — lives below the committed lines. It is redrawn in place
 *    by clearing the lines it occupies (no full-screen `\x1b[2J`).
 *  - Multiple synchronous `dispatch()` calls collapse into one paint via
 *    a microtask, so a chain like `widget submit → submit cmd → run` only
 *    paints once with the *latest* state — fixing the "press Enter,
 *    nothing changes until the next key" bug.
 *  - Hints are rendered by each widget itself; the bridge does NOT add a
 *    second copy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import {
  ANSI,
  buildStockIndex,
  complete,
  createDefaultRegistry,
  EMPTY_STOCK_INDEX,
  fromBrowserEvent,
  getRunner,
  initialState,
  paint,
  reduce,
  runCommand,
  stockListAction,
  stripAnsi,
  toKeySpec,
  type CommandCtx,
  type Effect,
  type Event,
  type StockIndex,
  type TerminalState,
} from '@quant/terminal';

import { useUiStore } from '../../lib/stores/ui.store.js';

const PROMPT = paint('$ ', ANSI.cyan, ANSI.bold);
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Per-instance render memory — what the bridge has already committed to xterm. */
interface RenderMem {
  /** Number of `state.history` entries already written into scrollback. */
  committedHistory: number;
  /** Number of *physical* footer lines currently on screen (after the last write). */
  footerRows: number;
  /** True while the very first paint hasn't happened yet. */
  initial: boolean;
  /** Frame index for the running-state spinner. */
  spinnerTick: number;
}

export interface TerminalApi {
  readonly mount: (host: HTMLDivElement) => void;
  readonly unmount: () => void;
  readonly state: TerminalState;
}

export function useTerminal(): TerminalApi {
  const [state, setState] = useState<TerminalState>(initialState);
  const stateRef = useRef<TerminalState>(state);
  stateRef.current = state;

  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const indexRef = useRef<StockIndex>(EMPTY_STOCK_INDEX);
  const abortRef = useRef<AbortController | null>(null);
  const memRef = useRef<RenderMem>({ committedHistory: 0, footerRows: 0, initial: true, spinnerTick: 0 });
  const paintScheduledRef = useRef<boolean>(false);
  const spinnerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const registry = useMemo(() => createDefaultRegistry(), []);

  const ctxStores = useMemo(
    () => ({
      ui: {
        getFocusCode: (): string | null => useUiStore.getState().focusCode,
        setFocusCode: (code: string | null): void => useUiStore.getState().setFocusCode(code),
      },
    }),
    [],
  );

  const buildCtx = useCallback((): CommandCtx => {
    const ac = new AbortController();
    abortRef.current = ac;
    return {
      actions: getRunner(),
      stockIndex: indexRef.current,
      stores: ctxStores,
      signal: ac.signal,
    };
  }, [ctxStores]);

  /** Schedule one paint at microtask boundary (collapses chain dispatches). */
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
    // applyEffect is stable through the same memoization closure
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schedulePaint],
  );

  const applyEffect = useCallback(
    (eff: Effect): void => {
      if (eff.kind === 'runCommand') {
        const ctx = buildCtx();
        void runCommand(eff.line, ctx, registry).then((events: readonly Event[]) => {
          for (const ev of events) dispatch(ev);
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
    [buildCtx, dispatch, registry, /* applyCompletion */],
    // applyCompletion is stable below
  );

  const applyCompletion = useCallback((): void => {
    const cur = stateRef.current;
    const env = {
      commands: registry.list().map((c) => c.name),
      subcommands: Object.fromEntries(
        registry.list().map((c) => [c.name, c.subcommands ?? []]),
      ) as Readonly<Record<string, readonly string[]>>,
      paramCompleter: (cmdName: string, idx: number, fragment: string) => {
        const spec = registry.resolve(cmdName);
        if (spec?.complete === undefined) return [];
        return spec.complete(idx, fragment, buildCtx());
      },
    };
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
    // Multiple — insert the longest common prefix beyond the user fragment
    if (r.commonPrefix.length > fragmentText.length) {
      const next = cur.buffer.slice(0, r.tokenStart) + r.commonPrefix + cur.buffer.slice(r.tokenEnd);
      const cursor = r.tokenStart + r.commonPrefix.length;
      dispatch({ kind: 'setBuffer', buffer: next, cursor });
      return;
    }
    // Display candidates inline
    dispatch({
      kind: 'setCandidates',
      candidates: r.candidates.map((c) => c.label).slice(0, 16),
    });
  }, [buildCtx, dispatch, registry]);

  const observerRef = useRef<ResizeObserver | null>(null);

  const mount = useCallback(
    (host: HTMLDivElement): void => {
      if (termRef.current !== null) {
        try {
          termRef.current.dispose();
        } catch {
          /* no-op */
        }
        termRef.current = null;
      }
      // Geek-style font (Monaspace Neon, with sensible fallbacks) and
      // cyber theme palette pulled from `lib/theme/tokens.ts:term.*`.
      const term = new Terminal({
        fontFamily:
          '"Monaspace Neon", "Monaspace Krypton", "Monaspace Argon", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
        fontSize: 15,
        letterSpacing: 0,
        lineHeight: 1.2,
        cursorBlink: true,
        // `block` reads as a chunky, fully-filled cell — the closest xterm
        // can render to "bold cursor". `cursorStyle: 'underline'` is too
        // thin a line at typical font sizes; bumping fontSize alone doesn't
        // thicken it enough.
        cursorStyle: 'block',
        cursorWidth: 2,
        convertEol: true,
        scrollback: 1000,
        // Bridge the cyber palette to xterm's ANSI slots so paint() output
        // (ANSI.green / ANSI.cyan / ANSI.red / ANSI.gray / ANSI.yellow) maps
        // onto our neon colors instead of xterm's default washed-out hues.
        theme: {
          background: '#06080a', // term.bg
          foreground: '#cfead8', // term.ink
          cursor: '#5eff9c', // term.green
          cursorAccent: '#06080a',
          selectionBackground: '#1f8a4f', // term.greenDark
          black: '#0a0e10', // term.panel
          red: '#ff4d6d', // term.red
          green: '#5eff9c', // term.green
          yellow: '#ffc14d', // term.amber
          blue: '#5cf2ff', // term.cyan (no real blue in palette → use cyan)
          magenta: '#ff5cd1', // term.magenta
          cyan: '#5cf2ff', // term.cyan
          white: '#cfead8', // term.ink
          brightBlack: '#4d6c61', // term.ink3
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
        /* host not laid out yet */
      }
      term.onData((data) => {
        const key = toKeySpec(data);
        if (key.special !== undefined || key.text !== undefined) {
          dispatch({ kind: 'key', key });
        }
      });
      // Catch shortcuts the browser swallows before xterm sees them
      // (Cmd+Arrow on macOS, Alt+Arrow on every platform).
      term.attachCustomKeyEventHandler((ev) => {
        const key = fromBrowserEvent(ev);
        if (key === null) return true;
        ev.preventDefault();
        dispatch({ kind: 'key', key });
        return false;
      });
      termRef.current = term;
      fitRef.current = fit;
      memRef.current = { committedHistory: 0, footerRows: 0, initial: true, spinnerTick: 0 };

      term.writeln(paint('qX//OS terminal · type `help` to get started', ANSI.gray));
      paintTerminal(
        term,
        stateRef.current,
        memRef.current,
        useUiStore.getState().focusCode,
      );

      void preloadIndex(indexRef);

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
    [dispatch, schedulePaint],
  );

  const unmount = useCallback((): void => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
  }, []);

  useEffect(() => () => unmount(), [unmount]);

  // Repaint when the global focus code changes — the bottom status bar
  // shows `FOCUS <code>` and reads from `ui.store` at paint time, so it
  // would otherwise stay stale until the next engine event.
  useEffect(() => {
    const unsub = useUiStore.subscribe((s, prev) => {
      if (s.focusCode !== prev.focusCode) schedulePaint();
    });
    return () => {
      unsub();
    };
  }, [schedulePaint]);

  // Spinner ticker — animates the running/cancelling/fetching footer.
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

  return useMemo<TerminalApi>(() => ({ mount, unmount, state }), [mount, unmount, state]);
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

/* ---------- incremental rendering ---------- */

function paintTerminal(term: Terminal | null, state: TerminalState, mem: RenderMem, _focusCode: string | null): void {
  if (term === null) return;

  // History shrunk (e.g. `clear` / `clear last N` reset state.history): we
  // can't selectively erase past `writeln`s in xterm's scrollback, so wipe
  // the screen + scrollback and re-write what remains. Reset `initial` so
  // the next "clear footer" branch falls through to the initial-paint path.
  const histShrunk = state.history.length < mem.committedHistory;
  if (histShrunk) {
    term.clear();
    term.write('\x1b[2J\x1b[H');
    mem.committedHistory = 0;
    mem.footerRows = 0;
    mem.initial = true;
  }

  // 1. Clear the previous footer in place. After the last paint the cursor
  //    sits on the LAST row of the previous footer (we don't end with \n),
  //    so we move up `footerRows - 1` rows then erase to end of screen.
  //    `\x1b[J` erases everything from the cursor down — that wipes both
  //    the active footer AND the bottom status bar, so we re-paint both
  //    fresh below.
  if (!mem.initial && mem.footerRows > 0) {
    if (mem.footerRows > 1) {
      term.write(`\x1b[${String(mem.footerRows - 1)}A`);
    }
    term.write('\r\x1b[J');
  } else if (mem.initial) {
    term.write('\r\x1b[J');
    mem.initial = false;
  }

  // 2. Append any new history entries to scrollback (committed forever).
  while (mem.committedHistory < state.history.length) {
    const entry = state.history[mem.committedHistory];
    if (entry !== undefined) writeHistoryEntry(term, entry);
    mem.committedHistory += 1;
  }

  // 3. Render the active footer (prompt / widget body) and remember its row
  //    count so the next paint can clear it. We re-enable the cursor before
  //    painting so that, after a previous frame hid it (e.g. an enum field
  //    in form-prompt), the next text-input footer shows it again. Widgets
  //    that need it hidden append `\x1b[?25l` at the very end of their body.
  term.write('\x1b[?25h');
  const footer = renderFooter(term, state, mem);
  if (footer.length > 0) {
    term.write(footer);
    mem.footerRows = countWrappedRows(footer, term.cols);
  } else {
    mem.footerRows = 0;
  }

  // The dedicated status bar at the bottom of the viewport is now
  // rendered as React (TipsBar) outside xterm — see feat-term-main.tsx.
  // No DECSTBM / absolute-positioned status row needed here anymore.
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
  // frozen interactive entry
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
    return state.active.widget.render(state.active.state, cols);
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
  // idle
  const tail =
    state.cursor < state.buffer.length
      ? `\x1b[${String(state.buffer.length - state.cursor)}D`
      : '';
  const promptLine = `${PROMPT}${state.buffer}${tail}`;
  if (state.candidates.length > 0) {
    const list = state.candidates
      .map((c) => paint(c, ANSI.gray))
      .join(paint(' · ', ANSI.gray));
    return `${list}\n${promptLine}`;
  }
  return promptLine;
}

/** Count the number of physical rows a string occupies given current cols. */
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
