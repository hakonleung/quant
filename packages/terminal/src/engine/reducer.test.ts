import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../engine/reducer.js';
import type {
  Event,
  HistoryEntry,
  InteractiveWidget,
  ReduceResult,
  TerminalState,
} from '../engine/state.js';

function feed(state: TerminalState, events: readonly Event[]): TerminalState {
  let acc: TerminalState = state;
  for (const ev of events) {
    acc = reduce(acc, ev).state;
  }
  return acc;
}

const printable = (text: string): Event => ({ kind: 'key', key: { text } });
const special = (s: string): Event => ({ kind: 'key', key: { special: s as never } });

describe('reducer — buffer editing (idle)', () => {
  it('appends typed character at cursor (golden)', () => {
    const s = feed(initialState, [printable('h'), printable('i')]);
    expect(s.buffer).toBe('hi');
    expect(s.cursor).toBe(2);
  });

  it('Backspace deletes one char at cursor', () => {
    const s = feed(initialState, [printable('a'), printable('b'), special('Backspace')]);
    expect(s.buffer).toBe('a');
    expect(s.cursor).toBe(1);
  });

  it('Backspace at cursor 0 is a no-op (boundary)', () => {
    const s = feed(initialState, [special('Backspace')]);
    expect(s.buffer).toBe('');
  });

  it('Left/Right move cursor within bounds', () => {
    const s = feed(initialState, [
      printable('a'),
      printable('b'),
      printable('c'),
      special('Left'),
      special('Left'),
    ]);
    expect(s.cursor).toBe(1);
    const s2 = reduce(s, special('Left')).state;
    const s3 = reduce(s2, special('Left')).state;
    expect(s3.cursor).toBe(0);
  });

  it('Home / End jump to extremes', () => {
    const s = feed(initialState, [printable('abc'), special('Home')]);
    expect(s.cursor).toBe(0);
    const s2 = reduce(s, special('End')).state;
    expect(s2.cursor).toBe(3);
  });

  it('CtrlC clears the buffer (no submit)', () => {
    const s = feed(initialState, [printable('xx'), special('CtrlC')]);
    expect(s.buffer).toBe('');
    expect(s.history).toHaveLength(0);
  });

  it('CtrlL clears history', () => {
    const s = feed(initialState, [
      { kind: 'submit', line: 'help' },
      { kind: 'result', entry: { body: 'hi', status: 'ok' } },
      special('CtrlL'),
    ]);
    expect(s.history).toEqual([]);
  });
});

describe('reducer — word / line shortcuts', () => {
  const setup = (text: string, cursor: number): TerminalState => {
    let s: TerminalState = initialState;
    for (const ch of text) s = reduce(s, printable(ch)).state;
    // move cursor back to requested position
    while (s.cursor > cursor) s = reduce(s, special('Left')).state;
    return s;
  };

  it('WordLeft jumps over the previous token (golden)', () => {
    const s = setup('hello world foo', 15);
    const r = reduce(s, special('WordLeft')).state;
    expect(r.cursor).toBe(12);
  });

  it('WordLeft over CJK groups cursor at the run start', () => {
    const s = setup('abc 茅台 600519', 13);
    const r = reduce(s, special('WordLeft')).state;
    // 'abc 茅台 600519' (length 13). End=13. WordLeft skips '600519' word
    // and stops at the space before it.
    expect(r.cursor).toBe(7);
  });

  it('WordRight skips next non-word + word', () => {
    const s = setup('hello world', 0);
    const r = reduce(s, special('WordRight')).state;
    expect(r.cursor).toBe(5);
  });

  it('WordBackspace deletes one word + leading whitespace', () => {
    const s = setup('hello world', 11);
    const r = reduce(s, special('WordBackspace')).state;
    expect(r.buffer).toBe('hello ');
    expect(r.cursor).toBe(6);
  });

  it('LineStartBackspace clears everything before cursor', () => {
    const s = setup('hello world', 5);
    const r = reduce(s, special('LineStartBackspace')).state;
    expect(r.buffer).toBe(' world');
    expect(r.cursor).toBe(0);
  });

  it('LineEndDelete clears from cursor to end', () => {
    const s = setup('hello world', 5);
    const r = reduce(s, special('LineEndDelete')).state;
    expect(r.buffer).toBe('hello');
  });
});

describe('reducer — submit / result lifecycle', () => {
  it('Enter submits non-empty buffer and emits runCommand effect', () => {
    const r1 = reduce(feed(initialState, [printable('help')]), special('Enter'));
    expect(r1.state.phase).toBe('running');
    expect(r1.state.buffer).toBe('');
    expect(r1.effects).toEqual([{ kind: 'runCommand', line: 'help' }]);
    expect(r1.state.history.at(-1)?.kind).toBe('prompt');
  });

  it('empty Enter is no-op (no history entry)', () => {
    const r = reduce(initialState, special('Enter'));
    expect(r.state.history).toEqual([]);
    expect(r.effects).toEqual([]);
  });

  it('result transitions running → idle and appends output entry', () => {
    const submitted = reduce(feed(initialState, [printable('help')]), special('Enter')).state;
    const r = reduce(submitted, { kind: 'result', entry: { body: 'ok', status: 'ok' } });
    expect(r.state.phase).toBe('idle');
    const last = r.state.history.at(-1) as HistoryEntry;
    expect(last.kind).toBe('output');
  });

  it('cancel during running emits abort + cancelling phase', () => {
    const submitted = reduce(
      feed(initialState, [printable('analyze 600519 --force')]),
      special('Enter'),
    ).state;
    const r: ReduceResult = reduce(submitted, { kind: 'cancel' });
    expect(r.state.phase).toBe('cancelling');
    expect(r.effects).toEqual([{ kind: 'abort' }]);
  });
});

describe('reducer — cmdHistory navigation (Up/Down)', () => {
  it('Up recalls last submitted line and saves current edit', () => {
    let s = feed(initialState, [printable('first'), special('Enter')]);
    s = reduce(s, { kind: 'result', entry: { body: '', status: 'ok' } }).state;
    s = feed(s, [printable('half')]);
    s = reduce(s, special('Up')).state;
    expect(s.buffer).toBe('first');
    s = reduce(s, special('Down')).state;
    expect(s.buffer).toBe('half');
  });

  it('Down at -1 is no-op', () => {
    const s = reduce(initialState, special('Down')).state;
    expect(s.cmdIndex).toBe(-1);
  });
});

describe('reducer — interactive widget', () => {
  interface Pos {
    readonly idx: number;
    readonly items: readonly string[];
  }
  const widget: InteractiveWidget<Pos, string> = {
    title: 'pick',
    initialState: { idx: 0, items: ['a', 'b', 'c'] },
    hints: () => [{ keys: ['Enter'], label: 'pick' }],
    render: (s) => s.items.map((it, i) => (i === s.idx ? `> ${it}` : `  ${it}`)).join('\n'),
    snapshot: (s) => `idx=${String(s.idx)}`,
    handleKey: (s, key) => {
      if (key.special === 'Down') return { kind: 'state', next: { ...s, idx: s.idx + 1 } };
      if (key.special === 'Enter') return { kind: 'submit', result: s.items[s.idx] ?? '' };
      return { kind: 'state', next: s };
    },
    commit: (line) => ({ kind: 'command', line: `info ${line}` }),
  };

  it('startInteractive moves to interactive phase', () => {
    const r = reduce(initialState, { kind: 'startInteractive', widget });
    expect(r.state.phase).toBe('interactive');
    expect(r.state.active?.widget.title).toBe('pick');
  });

  it('Down advances widget state, render reflects new idx', () => {
    let s = reduce(initialState, { kind: 'startInteractive', widget }).state;
    s = reduce(s, special('Down')).state;
    expect((s.active?.state as Pos).idx).toBe(1);
  });

  it('Enter on widget commits → frozen entry + commitWidget effect', () => {
    let s = reduce(initialState, { kind: 'startInteractive', widget }).state;
    s = reduce(s, special('Down')).state;
    const r = reduce(s, special('Enter'));
    expect(r.state.phase).toBe('idle');
    expect(r.state.active).toBe(null);
    const last = r.state.history.at(-1) as HistoryEntry;
    expect(last.kind).toBe('frozen');
    expect(r.effects).toEqual([
      { kind: 'commitWidget', resolution: { kind: 'command', line: 'info b' } },
    ]);
  });

  it('Esc on widget collapses interaction to a single "canceled" output', () => {
    let s = reduce(initialState, { kind: 'startInteractive', widget }).state;
    s = reduce(s, special('Escape')).state;
    expect(s.phase).toBe('idle');
    const last = s.history.at(-1) as HistoryEntry;
    expect(last.kind).toBe('output');
    if (last.kind === 'output') {
      expect(last.body).toBe('canceled');
      expect(last.status).toBe('info');
    }
  });

  it('CtrlC inside widget acts like Esc', () => {
    let s = reduce(initialState, { kind: 'startInteractive', widget }).state;
    s = reduce(s, special('CtrlC')).state;
    expect(s.phase).toBe('idle');
  });

  it('keys are routed to widget while interactive (idle key handler is bypassed)', () => {
    // 'a' would normally go into the prompt buffer; in interactive it must
    // not pollute the buffer.
    let s = reduce(initialState, { kind: 'startInteractive', widget }).state;
    s = reduce(s, printable('a')).state;
    expect(s.buffer).toBe('');
  });
});

/* ── streaming events (used by /agent) ──────────────────────────────── */

describe('reducer — streaming output (golden)', () => {
  const STREAM = 's-1';

  it('streamOpen appends an OutputEntry with streaming=true', () => {
    const s = reduce(initialState, {
      kind: 'streamOpen',
      streamId: STREAM,
      status: 'info',
      initialBody: '▶ /agent…',
    }).state;
    expect(s.history.length).toBe(1);
    const last = s.history.at(-1);
    expect(last?.kind).toBe('output');
    if (last?.kind === 'output') {
      expect(last.id).toBe(STREAM);
      expect(last.streaming).toBe(true);
      expect(last.status).toBe('info');
      expect(last.body).toBe('▶ /agent…');
    }
  });

  it('streamChunk appends delta to the matching entry', () => {
    let s = reduce(initialState, {
      kind: 'streamOpen',
      streamId: STREAM,
      initialBody: '',
    }).state;
    s = reduce(s, { kind: 'streamChunk', streamId: STREAM, delta: 'hello' }).state;
    s = reduce(s, { kind: 'streamChunk', streamId: STREAM, delta: ' world' }).state;
    const last = s.history.at(-1);
    if (last?.kind === 'output') expect(last.body).toBe('hello world');
    else throw new Error('expected output entry');
  });

  it('streamStepLog appends a newline-separated line', () => {
    let s = reduce(initialState, { kind: 'streamOpen', streamId: STREAM }).state;
    s = reduce(s, { kind: 'streamChunk', streamId: STREAM, delta: 'intro' }).state;
    s = reduce(s, {
      kind: 'streamStepLog',
      streamId: STREAM,
      line: '▶ /focus 600519',
    }).state;
    const last = s.history.at(-1);
    if (last?.kind === 'output')
      expect(last.body).toBe('intro\n▶ /focus 600519');
    else throw new Error('expected output entry');
  });

  it('streamClose flips streaming=false and appends optional footer', () => {
    let s = reduce(initialState, { kind: 'streamOpen', streamId: STREAM }).state;
    s = reduce(s, { kind: 'streamChunk', streamId: STREAM, delta: 'final answer' }).state;
    s = reduce(s, {
      kind: 'streamClose',
      streamId: STREAM,
      status: 'ok',
      footer: '—— ¥0.0010',
    }).state;
    const last = s.history.at(-1);
    if (last?.kind === 'output') {
      expect(last.streaming).toBe(false);
      expect(last.status).toBe('ok');
      expect(last.body).toBe('final answer\n—— ¥0.0010');
    } else throw new Error('expected output entry');
  });

  it('streamOpen on an already-open stream is a no-op (idempotent)', () => {
    const s1 = reduce(initialState, { kind: 'streamOpen', streamId: STREAM }).state;
    const s2 = reduce(s1, { kind: 'streamOpen', streamId: STREAM, initialBody: 'x' }).state;
    expect(s2.history.length).toBe(1);
    if (s2.history[0]?.kind === 'output') {
      // initialBody is ignored on the second open.
      expect(s2.history[0].body).toBe('');
    }
  });

  it('streamChunk with unknown streamId is a silent no-op', () => {
    const s = reduce(initialState, {
      kind: 'streamChunk',
      streamId: 'never-opened',
      delta: 'lost',
    }).state;
    expect(s.history.length).toBe(0);
  });

  it('streamClose without footer just toggles the flag', () => {
    let s = reduce(initialState, { kind: 'streamOpen', streamId: STREAM, initialBody: 'a' }).state;
    s = reduce(s, { kind: 'streamClose', streamId: STREAM }).state;
    const last = s.history.at(-1);
    if (last?.kind === 'output') {
      expect(last.body).toBe('a');
      expect(last.streaming).toBe(false);
    }
  });
});
