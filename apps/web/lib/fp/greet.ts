import { QuantError } from '@quant/shared';

/**
 * Pure greeting function. Lives in `lib/fp` per CLAUDE.md §2.5.1 — no IO, no globals.
 * Mirrors `services/py/quant_core/domain/pure/greet.py` so the test pipeline
 * exercises the same `QuantError` contract on both sides of the language boundary.
 */
export function greet(name: string): string {
  if (name.length === 0) {
    throw new QuantError('INVALID_ARGUMENT', 'greet: name must be non-empty');
  }
  return `Hello, ${name}`;
}
