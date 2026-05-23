import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { uiRegistry } from '../registry.js';
import { CmdButton } from './cmd-button.js';

// `sector.rm` is the canonical example: a manifest entry that carries
// a `ui` block (scope MKT, keys ['D'], group action, label 'Delete
// focused sector'). Reusing a real manifest entry keeps the test honest.
const TEST_CELL = 'sector.rm';

function Wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
  return <ChakraProvider value={defaultSystem}>{children}</ChakraProvider>;
}

beforeEach(() => {
  uiRegistry.__reset();
});

afterEach(() => {
  cleanup();
  uiRegistry.__reset();
});

describe('CmdButton', () => {
  it('renders the cell label as aria-label and visible text', () => {
    const handler = vi.fn();
    uiRegistry.bind(TEST_CELL, handler);
    render(
      <Wrapper>
        <CmdButton cmd={TEST_CELL} />
      </Wrapper>,
    );
    const btn = screen.getByRole('button', { name: 'Delete focused sector' });
    expect(btn).toBeDefined();
  });

  it('overrides label with children when passed', () => {
    uiRegistry.bind(TEST_CELL, vi.fn());
    render(
      <Wrapper>
        <CmdButton cmd={TEST_CELL}>Custom Label</CmdButton>
      </Wrapper>,
    );
    expect(screen.getByText('Custom Label')).toBeDefined();
  });

  it('mouse click dispatches the cell handler', () => {
    const handler = vi.fn();
    uiRegistry.bind(TEST_CELL, handler);
    render(
      <Wrapper>
        <CmdButton cmd={TEST_CELL} args={{ id: 's1' }} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete focused sector' }));
    expect(handler).toHaveBeenCalledWith({ id: 's1' });
  });

  it('renders aria-disabled when no handler is bound', () => {
    render(
      <Wrapper>
        <CmdButton cmd={TEST_CELL} />
      </Wrapper>,
    );
    const btn = screen.getByRole('button', { name: 'Delete focused sector' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('does not dispatch when disabled', () => {
    const handler = vi.fn();
    render(
      <Wrapper>
        <CmdButton cmd={TEST_CELL} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete focused sector' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('asMenuItem renders an anchor with role=button + tabIndex', () => {
    uiRegistry.bind(TEST_CELL, vi.fn());
    render(
      <Wrapper>
        <CmdButton cmd={TEST_CELL} asMenuItem />
      </Wrapper>,
    );
    const link = screen.getByRole('button', { name: 'Delete focused sector' });
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('tabindex')).toBe('0');
  });

  it('asMenuItem dispatches on Enter and Space', () => {
    const handler = vi.fn();
    uiRegistry.bind(TEST_CELL, handler);
    render(
      <Wrapper>
        <CmdButton cmd={TEST_CELL} asMenuItem />
      </Wrapper>,
    );
    const link = screen.getByRole('button', { name: 'Delete focused sector' });
    fireEvent.keyDown(link, { key: 'Enter' });
    fireEvent.keyDown(link, { key: ' ' });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
