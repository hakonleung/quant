/**
 * `makeSectorId(name, rng)` — pure id generator for new sectors.
 *
 * Extracted out of `new-sector-dialog.tsx` so the random source is
 * injectable (CLAUDE.md §1.2 — no `Math.random()` in component bodies).
 * Tests pass a deterministic `rng` to assert the slug logic.
 *
 * Slugging rules:
 *   - lowercase, ASCII alnum + CJK chars kept, all other runs → `-`
 *   - leading / trailing dashes trimmed
 *   - slug truncated to 24 chars
 *   - 6-char base36 suffix appended (collision guard for same-named sectors)
 *   - reserved id `ALL_SECTOR_ID` is shifted with an `-x` tail so a freshly
 *     minted sector can never overlap the synthetic "全 A" view
 */

import { ALL_SECTOR_ID } from '../stores/ui.store.js';

/** Random base36 fragment producer; takes nothing, returns 6+ chars. */
export type RandomSuffix = () => string;

/** Default suffix source — `Math.random` boxed for deterministic injection. */
export const defaultRandomSuffix: RandomSuffix = () =>
  Math.random().toString(36).slice(2, 8);

export function makeSectorId(name: string, rng: RandomSuffix = defaultRandomSuffix): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 24);
  const base = slug.length === 0 ? 'sec' : slug;
  const suffix = rng().slice(0, 6);
  const id = `${base}-${suffix}`;
  return id === ALL_SECTOR_ID ? `${id}-x` : id;
}
