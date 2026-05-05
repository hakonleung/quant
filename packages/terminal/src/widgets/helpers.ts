/**
 * Output helpers used by command implementations to keep their `run` bodies
 * short and declarative. Pure (CLAUDE.md §2.5.1).
 */

import type {
  CommitResolution,
  InteractiveWidgetAny,
  OutputEntry,
} from '../engine/state.js';

export function textOk(body: string): { kind: 'text'; status: 'ok'; tail: { body: string } } {
  return { kind: 'text', status: 'ok', tail: { body } };
}
export function textErr(body: string): { kind: 'text'; status: 'err'; tail: { body: string } } {
  return { kind: 'text', status: 'err', tail: { body } };
}
export function textCached(body: string): { kind: 'text'; status: 'cached'; tail: { body: string } } {
  return { kind: 'text', status: 'cached', tail: { body } };
}

export function interactive(
  widget: InteractiveWidgetAny,
): { kind: 'interactive'; widget: InteractiveWidgetAny } {
  return { kind: 'interactive', widget };
}

/** Convenience for resolving a widget submit into a follow-up command. */
export function commandResolution(line: string): CommitResolution {
  return { kind: 'command', line };
}

export function widgetResolution(next: InteractiveWidgetAny): CommitResolution {
  return { kind: 'widget', next };
}

export function outputResolution(
  body: string,
  status: OutputEntry['status'] = 'ok',
): CommitResolution {
  return { kind: 'output', entry: { body, status } };
}

export const noopResolution: CommitResolution = { kind: 'noop' };
