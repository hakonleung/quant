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

const PROMPT = paint('▸ ', ANSI.cyan);

/** Per-instance render memory — what the bridge has already committed to xterm. */
interface RenderMem {
  /** Number of `state.history` entries already written into scrollback. */
  committedHistory: number;
  /** Number of *physical* footer lines currently on screen (after the last write). */
  footerRows: number;
  /** True while the very first paint hasn't happened yet. */
  initial: boolean;
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
  const memRef = useRef<RenderMem>({ committedHistory: 0, footerRows: 0, initial: true });
  const paintScheduledRef = useRef<boolean>(false);

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
      paintTerminal(termRef.current, stateRef.current, memRef.current);
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
        void runCommand(eff.line, ctx, registry).then((next: Event) => {
          dispatch(next);
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
        fontSize: 12,
        letterSpacing: 0,
        lineHeight: 1.15,
        cursorBlink: true,
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
      memRef.current = { committedHistory: 0, footerRows: 0, initial: true };

      term.writeln(paint('QUANT//OS terminal · type `help` to get started', ANSI.gray));
      paintTerminal(term, stateRef.current, memRef.current);

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

function paintTerminal(term: Terminal | null, state: TerminalState, mem: RenderMem): void {
  if (term === null) return;

  // 1. Clear the previous footer in place. After the last paint the cursor
  //    sits on the LAST row of the previous footer (we don't end with \n),
  //    so we move up `footerRows - 1` rows then erase to end of screen.
  //    On the very first paint there's no footer yet — `\r\x1b[J` is
  //    enough to ensure we start from column 0 of a clean region.
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

  // 3. Render the active footer and remember how tall it is.
  const footer = renderFooter(term, state);
  if (footer.length === 0) {
    mem.footerRows = 0;
    return;
  }
  term.write(footer);
  mem.footerRows = countWrappedRows(footer, term.cols);
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

function renderFooter(term: Terminal, state: TerminalState): string {
  const cols = term.cols;
  if (state.phase === 'interactive' && state.active !== null) {
    // Widgets render their own hint bar; the bridge no longer adds a copy.
    return state.active.widget.render(state.active.state, cols);
  }
  if (state.phase === 'cancelling') {
    return paint('cancelling…', ANSI.yellow);
  }
  if (state.phase === 'running') {
    return paint(`${PROMPT}${state.buffer}`, ANSI.dim);
  }
  // idle
  const tail = state.cursor < state.buffer.length
    ? `\x1b[${String(state.buffer.length - state.cursor)}D`
    : '';
  const promptLine = `${PROMPT}${state.buffer}${tail}`;
  if (state.candidates.length > 0) {
    const list = state.candidates
      .map((c) => paint(c, ANSI.gray))
      .join(paint(' · ', ANSI.gray));
    // Candidates row sits ABOVE the prompt so the cursor naturally lands
    // at the end of the prompt without needing save/restore (xterm.js does
    // not always honor those CSI codes when wrapped).
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
