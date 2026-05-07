import { describe, expect, it } from 'vitest';
import { describe as describeKey, toKeySpec } from '../engine/keymap.js';

describe('toKeySpec', () => {
  it('returns empty for empty string (boundary)', () => {
    expect(toKeySpec('')).toEqual({});
  });

  it.each([
    ['\r', 'Enter'],
    ['\n', 'Enter'],
    ['\x1b', 'Escape'],
    ['\x7f', 'Backspace'],
    ['\b', 'Backspace'],
    ['\t', 'Tab'],
    ['\x1b[Z', 'ShiftTab'],
    ['\x1b[A', 'Up'],
    ['\x1b[B', 'Down'],
    ['\x1b[C', 'Right'],
    ['\x1b[D', 'Left'],
    ['\x1b[H', 'Home'],
    ['\x1bOH', 'Home'],
    ['\x1b[F', 'End'],
    ['\x1b[5~', 'PageUp'],
    ['\x1b[6~', 'PageDown'],
    ['\x1b[3~', 'Delete'],
    ['\x03', 'CtrlC'],
    ['\x0c', 'CtrlL'],
    ['\x04', 'CtrlD'],
    ['\x1b\r', 'CtrlEnter'],
  ])('maps %j → %s (special)', (input, expected) => {
    expect(toKeySpec(input).special).toBe(expected);
  });

  it('returns text spec for printable ASCII', () => {
    expect(toKeySpec('a')).toEqual({ text: 'a' });
  });

  it('returns text spec for CJK character', () => {
    expect(toKeySpec('茅')).toEqual({ text: '茅' });
  });

  it('treats long non-ESC chunk as paste', () => {
    expect(toKeySpec('hello world')).toEqual({ text: 'hello world' });
  });

  it('falls back to Escape for unknown ESC sequence', () => {
    expect(toKeySpec('\x1b[?1234~').special).toBe('Escape');
  });

  it('drops unmapped control chars below 0x20', () => {
    // 0x10 (DLE) is unmapped — should drop. 0x05 (Ctrl+E) maps to End now.
    expect(toKeySpec('\x10')).toEqual({});
  });

  it('describe formats specials and text', () => {
    expect(describeKey({ special: 'Enter' })).toBe('Enter');
    expect(describeKey({ text: 'a' })).toBe('"a"');
    expect(describeKey({})).toBe('<empty>');
  });

  it.each([
    ['\x01', 'Home'],
    ['\x05', 'End'],
    ['\x15', 'LineStartBackspace'],
    ['\x0b', 'LineEndDelete'],
    ['\x17', 'WordBackspace'],
    ['\x1bb', 'WordLeft'],
    ['\x1bf', 'WordRight'],
    ['\x1b[1;5D', 'WordLeft'],
    ['\x1b[1;5C', 'WordRight'],
  ])('maps %j → %s (emacs / ctrl-arrow)', (input, expected) => {
    expect(toKeySpec(input).special).toBe(expected);
  });
});

describe('fromBrowserEvent', () => {
  // import locally so we don't change the top-level imports
  const { fromBrowserEvent } =
    require('../engine/keymap.ts') as typeof import('../engine/keymap.ts');
  const ev = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', init);

  it('Cmd+Left → Home', () => {
    expect(fromBrowserEvent(ev({ key: 'ArrowLeft', metaKey: true }))?.special).toBe('Home');
  });
  it('Cmd+Right → End', () => {
    expect(fromBrowserEvent(ev({ key: 'ArrowRight', metaKey: true }))?.special).toBe('End');
  });
  it('Alt+Left → WordLeft', () => {
    expect(fromBrowserEvent(ev({ key: 'ArrowLeft', altKey: true }))?.special).toBe('WordLeft');
  });
  it('Alt+Backspace → WordBackspace', () => {
    expect(fromBrowserEvent(ev({ key: 'Backspace', altKey: true }))?.special).toBe('WordBackspace');
  });
  it('Cmd+Backspace → LineStartBackspace', () => {
    expect(fromBrowserEvent(ev({ key: 'Backspace', metaKey: true }))?.special).toBe(
      'LineStartBackspace',
    );
  });
  it('Plain ArrowLeft returns null (let xterm handle)', () => {
    expect(fromBrowserEvent(ev({ key: 'ArrowLeft' }))).toBe(null);
  });
});
