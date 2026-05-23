'use client';

/**
 * `<CmdButton>` — mouse path through the UI command set.
 *
 * Dispatches `cellId` via the same engine the keyboard uses, so mouse,
 * keyboard, and AI all reach the same handler. The button automatically
 * derives `aria-label` from `manifest.entry(cmd).ui.label` and surfaces
 * the first key in `ui.keys` via `title` for discoverability.
 */

import { Box } from '@chakra-ui/react';
import {
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import { COMMAND_MANIFEST, type CommandManifestEntry } from '@quant/shared';

import { useCommand } from '../hooks/use-command.js';
import { uiRegistry } from '../registry.js';

export interface CmdButtonProps {
  readonly cmd: string;
  readonly args?: unknown;
  readonly children?: ReactNode;
  readonly className?: string;
  /** When true, renders as `<a role="button">` for use inside menus. */
  readonly asMenuItem?: boolean;
}

export const CmdButton = forwardRef(function CmdButton(
  { cmd, args, children, className, asMenuItem }: CmdButtonProps,
  ref: Ref<HTMLElement>,
): React.ReactElement {
  const dispatch = useCommand(cmd);
  const entry = manifestEntry(cmd);
  const ui = entry?.ui;
  const label = ui?.label ?? cmd;
  const firstKey = ui?.keys?.[0];
  const disabled = !uiRegistry.hasHandler(cmd);

  const onActivate = (): void => {
    if (disabled) return;
    void dispatch(args);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (asMenuItem !== true) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate();
    }
  };

  const focusRing = {
    outline: '2px solid',
    outlineColor: 'accent',
    outlineOffset: '2px',
  } as const;

  if (asMenuItem === true) {
    return (
      <Box
        as="a"
        ref={ref}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-disabled={disabled}
        title={firstKey}
        className={className}
        _focusVisible={focusRing}
        onClick={onActivate}
        onKeyDown={onKeyDown}
      >
        {children ?? label}
      </Box>
    );
  }

  return (
    <Box
      as="button"
      ref={ref}
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      title={firstKey}
      className={className}
      _focusVisible={focusRing}
      onClick={onActivate}
    >
      {children ?? label}
    </Box>
  );
});

function manifestEntry(id: string): CommandManifestEntry | undefined {
  return COMMAND_MANIFEST.find((e) => e.id === id);
}
