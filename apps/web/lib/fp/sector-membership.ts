/**
 * Pure diff helpers for the SelectSectorsDialog flow.
 *
 * Given the user's current selection (a set of sector ids), the
 * stock's existing memberships across user sectors, and the input
 * sector list, compute the per-sector deltas that need to be persisted
 * via `useSectorsStore.upsert`.
 *
 * Pure (CLAUDE.md §2.5.1) — no IO, no store dependency. The only
 * runtime input is the data; the dialog wires up the calls.
 */

interface SectorLike {
  readonly id: string;
  readonly kind: string;
  readonly codes: readonly string[];
}

export interface MembershipDiff<S extends SectorLike> {
  /** Sectors that should gain `code` (and the new codes array). */
  readonly added: readonly { readonly sector: S; readonly nextCodes: readonly string[] }[];
  /** Sectors that should lose `code` (and the new codes array). */
  readonly removed: readonly { readonly sector: S; readonly nextCodes: readonly string[] }[];
}

/**
 * @param userSectors  Mutable user sectors (kind === 'user'). Other kinds are ignored.
 * @param code         The stock code being managed.
 * @param selected     Sector ids that should contain `code` after apply.
 */
export function computeMembershipDiff<S extends SectorLike>(
  userSectors: readonly S[],
  code: string,
  selected: ReadonlySet<string>,
): MembershipDiff<S> {
  const added: { sector: S; nextCodes: readonly string[] }[] = [];
  const removed: { sector: S; nextCodes: readonly string[] }[] = [];
  for (const sector of userSectors) {
    if (sector.kind !== 'user') continue;
    const inNext = selected.has(sector.id);
    const inPrev = sector.codes.includes(code);
    if (inNext === inPrev) continue;
    if (inNext) {
      added.push({ sector, nextCodes: [...sector.codes, code] });
    } else {
      removed.push({ sector, nextCodes: sector.codes.filter((c) => c !== code) });
    }
  }
  return { added, removed };
}

/**
 * Default selection for the dialog: all user sectors that already
 * contain the focus stock.
 */
export function initialMembershipSelection(
  userSectors: readonly SectorLike[],
  code: string,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const s of userSectors) {
    if (s.kind !== 'user') continue;
    if (s.codes.includes(code)) out.add(s.id);
  }
  return out;
}
