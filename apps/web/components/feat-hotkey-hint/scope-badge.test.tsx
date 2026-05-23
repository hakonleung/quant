import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useFocusStore } from '../../lib/ui-cmd/store/focus.js';
import { ScopeBadge } from './scope-badge.js';

function Wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
  return <ChakraProvider value={defaultSystem}>{children}</ChakraProvider>;
}

beforeEach(() => {
  useFocusStore.setState({
    activeFeat: null,
    fullscreen: null,
    subFocus: [],
    modalOpen: false,
    hintOpen: false,
    hintMinimized: false,
  });
});

afterEach(() => {
  cleanup();
});

describe('ScopeBadge', () => {
  it('renders an em-dash when no Feat is active', () => {
    render(
      <Wrapper>
        <ScopeBadge />
      </Wrapper>,
    );
    const btn = screen.getByRole('button', { name: /active scope —/ });
    expect(btn).toBeDefined();
  });

  it('reflects the current activeFeat', () => {
    act(() => {
      useFocusStore.getState().setActive('MKT' as never);
    });
    render(
      <Wrapper>
        <ScopeBadge />
      </Wrapper>,
    );
    expect(screen.getByRole('button', { name: /active scope MKT/ })).toBeDefined();
  });

  it('hides while the hint dialog is open and not minimized', () => {
    act(() => {
      useFocusStore.getState().setHintOpen(true);
    });
    const { container } = render(
      <Wrapper>
        <ScopeBadge />
      </Wrapper>,
    );
    expect(container.querySelector('[aria-label^="active scope"]')).toBeNull();
  });

  it('stays visible alongside the minimized hint badge', () => {
    act(() => {
      useFocusStore.getState().setHintOpen(true);
      useFocusStore.getState().setHintMinimized(true);
    });
    render(
      <Wrapper>
        <ScopeBadge />
      </Wrapper>,
    );
    expect(screen.getByRole('button', { name: /active scope/ })).toBeDefined();
  });

  it('click opens the hint window', () => {
    render(
      <Wrapper>
        <ScopeBadge />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: /active scope/ }));
    expect(useFocusStore.getState().hintOpen).toBe(true);
  });
});
