import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetGlobalCellsForTest,
  installGlobalCells,
} from '../../lib/ui-cmd/global-cells.js';
import { uiRegistry } from '../../lib/ui-cmd/registry.js';
import { useFocusStore } from '../../lib/ui-cmd/store/focus.js';
import { FeatHotkeyHint } from './feat-hotkey-hint.js';

function Wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
  return <ChakraProvider value={defaultSystem}>{children}</ChakraProvider>;
}

beforeEach(() => {
  uiRegistry.__reset();
  __resetGlobalCellsForTest();
  useFocusStore.setState({
    activeFeat: null,
    fullscreen: null,
    subFocus: [],
    modalOpen: false,
    hintOpen: false,
    hintMinimized: false,
  });
  installGlobalCells();
});

afterEach(() => {
  cleanup();
  uiRegistry.__reset();
  __resetGlobalCellsForTest();
});

describe('FeatHotkeyHint', () => {
  it('renders nothing when hint is closed', () => {
    const { container } = render(
      <Wrapper>
        <FeatHotkeyHint />
      </Wrapper>,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders a non-modal dialog when hintOpen', () => {
    act(() => {
      useFocusStore.getState().setHintOpen(true);
    });
    render(
      <Wrapper>
        <FeatHotkeyHint />
      </Wrapper>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute('aria-modal')).toBe('false');
  });

  it('lists global navigation cells under "Navigate"', () => {
    act(() => {
      useFocusStore.getState().setHintOpen(true);
    });
    render(
      <Wrapper>
        <FeatHotkeyHint />
      </Wrapper>,
    );
    expect(screen.getByText('Navigate')).toBeDefined();
    expect(screen.getByText('Switch to market')).toBeDefined();
    expect(screen.getByText('Switch to equity chart')).toBeDefined();
  });

  it('minimize button collapses dialog to a badge', () => {
    act(() => {
      useFocusStore.getState().setHintOpen(true);
    });
    render(
      <Wrapper>
        <FeatHotkeyHint />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'minimize hint' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const badge = screen.getByRole('button', { name: /open keyboard hint/i });
    expect(badge).toBeDefined();
  });

  it('badge click restores the dialog', () => {
    act(() => {
      useFocusStore.getState().setHintOpen(true);
      useFocusStore.getState().setHintMinimized(true);
    });
    render(
      <Wrapper>
        <FeatHotkeyHint />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: /open keyboard hint/i }));
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('close button toggles hintOpen back to false', () => {
    act(() => {
      useFocusStore.getState().setHintOpen(true);
    });
    render(
      <Wrapper>
        <FeatHotkeyHint />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'close hint' }));
    expect(useFocusStore.getState().hintOpen).toBe(false);
  });
});
