import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLOSE_MODAL_CELL_ID,
  EXIT_FULLSCREEN_CELL_ID,
  HINT_TOGGLE_CELL_ID,
  type UiBinding,
  type UiCtx,
} from '../types.js';
import { createKeymapEngine } from './keymap-engine.js';

function binding(cellId: string, scope: string, seq: readonly string[]): UiBinding {
  return {
    cellId,
    seq,
    ui: { scope, keys: [seq.join(' ')], label: cellId, group: 'action' },
  };
}

function fireKey(target: EventTarget, init: KeyboardEventInit & { key: string }): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

describe('keymap engine — golden path', () => {
  let dispatch: ReturnType<typeof vi.fn>;
  let ctx: UiCtx;
  let bindings: UiBinding[];

  beforeEach(() => {
    dispatch = vi.fn();
    ctx = { activeFeat: null, fullscreen: null, subFocus: [], modalOpen: false, hintOpen: false };
    bindings = [binding('go-mkt', 'global', ['g', 'm'])];
  });

  it('two-key sequence dispatches exactly once', () => {
    const engine = createKeymapEngine({
      getCtx: () => ctx,
      getBindings: () => bindings,
      dispatch,
    });
    const tgt = document.body;
    engine.handle(fireKey(tgt, { key: 'g' }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(engine.buffer()).toEqual(['g']);
    engine.handle(fireKey(tgt, { key: 'm' }));
    expect(dispatch).toHaveBeenCalledWith('go-mkt');
    expect(engine.buffer()).toEqual([]);
  });

  it('single-key exact match dispatches', () => {
    bindings = [binding('hint', 'global', ['x'])];
    const engine = createKeymapEngine({
      getCtx: () => ctx,
      getBindings: () => bindings,
      dispatch,
    });
    engine.handle(fireKey(document.body, { key: 'x' }));
    expect(dispatch).toHaveBeenCalledWith('hint');
  });
});

describe('keymap engine — special keys', () => {
  it('? dispatches hint-toggle regardless of buffer', () => {
    const dispatch = vi.fn();
    const engine = createKeymapEngine({
      getCtx: () => ({ activeFeat: null, fullscreen: null, subFocus: [], modalOpen: false, hintOpen: false }),
      getBindings: () => [binding('go-mkt', 'global', ['g', 'm'])],
      dispatch,
    });
    engine.handle(fireKey(document.body, { key: 'g' }));
    engine.handle(fireKey(document.body, { key: '?', shiftKey: true }));
    expect(dispatch).toHaveBeenCalledWith(HINT_TOGGLE_CELL_ID);
    expect(engine.buffer()).toEqual([]);
  });

  it('Esc exits fullscreen first', () => {
    const dispatch = vi.fn();
    const engine = createKeymapEngine({
      getCtx: () => ({ activeFeat: 'MKT', fullscreen: 'MKT', subFocus: [], modalOpen: false, hintOpen: false }),
      getBindings: () => [],
      dispatch,
    });
    engine.handle(fireKey(document.body, { key: 'Escape' }));
    expect(dispatch).toHaveBeenCalledWith(EXIT_FULLSCREEN_CELL_ID);
  });

  it('Esc clears buffer when no fullscreen', () => {
    const dispatch = vi.fn();
    const engine = createKeymapEngine({
      getCtx: () => ({ activeFeat: null, fullscreen: null, subFocus: [], modalOpen: false, hintOpen: false }),
      getBindings: () => [binding('go-mkt', 'global', ['g', 'm'])],
      dispatch,
    });
    engine.handle(fireKey(document.body, { key: 'g' }));
    expect(engine.buffer()).toEqual(['g']);
    engine.handle(fireKey(document.body, { key: 'Escape' }));
    expect(engine.buffer()).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('Esc closes modal when no fullscreen and no buffer', () => {
    const dispatch = vi.fn();
    const engine = createKeymapEngine({
      getCtx: () => ({ activeFeat: null, fullscreen: null, subFocus: [], modalOpen: true, hintOpen: false }),
      getBindings: () => [],
      dispatch,
    });
    engine.handle(fireKey(document.body, { key: 'Escape' }));
    expect(dispatch).toHaveBeenCalledWith(CLOSE_MODAL_CELL_ID);
  });
});

describe('keymap engine — editable target skip', () => {
  it('typing in <input> is ignored', () => {
    const dispatch = vi.fn();
    const engine = createKeymapEngine({
      getCtx: () => ({ activeFeat: null, fullscreen: null, subFocus: [], modalOpen: false, hintOpen: false }),
      getBindings: () => [binding('hint', 'global', ['x'])],
      dispatch,
    });
    const input = document.createElement('input');
    document.body.appendChild(input);
    engine.handle(fireKey(input, { key: 'x' }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('data-allow-hotkeys opt-in lets keys through', () => {
    const dispatch = vi.fn();
    const engine = createKeymapEngine({
      getCtx: () => ({ activeFeat: null, fullscreen: null, subFocus: [], modalOpen: false, hintOpen: false }),
      getBindings: () => [binding('hint', 'global', ['x'])],
      dispatch,
    });
    const input = document.createElement('input');
    input.setAttribute('data-allow-hotkeys', 'true');
    document.body.appendChild(input);
    engine.handle(fireKey(input, { key: 'x' }));
    expect(dispatch).toHaveBeenCalledWith('hint');
  });
});

describe('keymap engine — timeout', () => {
  it('sequence resets after timeoutMs idle', () => {
    const dispatch = vi.fn();
    let clock = 1000;
    const engine = createKeymapEngine({
      getCtx: () => ({ activeFeat: null, fullscreen: null, subFocus: [], modalOpen: false, hintOpen: false }),
      getBindings: () => [binding('go-mkt', 'global', ['g', 'm'])],
      dispatch,
      now: () => clock,
      timeoutMs: 1000,
    });
    engine.handle(fireKey(document.body, { key: 'g' }));
    expect(engine.buffer()).toEqual(['g']);
    clock += 2000;
    engine.handle(fireKey(document.body, { key: 'm' }));
    // Buffer was cleared by timeout; lone 'm' is not a match → none, no dispatch.
    expect(dispatch).not.toHaveBeenCalled();
  });
});
