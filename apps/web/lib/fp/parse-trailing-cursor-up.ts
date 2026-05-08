/**
 * Net upward cursor displacement from CSI cursor-movement escapes that
 * appear at the very end of `text`. Used by the terminal bridge so the
 * next paint can move the cursor back down to the body's bottom row
 * before clearing — see `useTerminal.paintTerminal` step 1.
 *
 * Recognised:
 *   `\x1b[<n>F` / `\x1b[<n>A` → up by n   (CR is implied for F)
 *   `\x1b[<n>B` / `\x1b[<n>E` → down by n
 *
 * `\x1b[<n>G` (column move) and DEC private modes such as `\x1b[?25h` /
 * `\x1b[?25l` (show / hide cursor) are stripped but contribute 0 to the
 * net offset. A bare trailing `\r` is also stripped (no row movement).
 * Anything else stops the walk — only contiguous trailing escapes are
 * tallied, so cursor escapes embedded earlier in a coloured run are not
 * counted.
 *
 * Pure (CLAUDE.md §2.5.1) — string in, number out, no IO.
 */
export function parseTrailingCursorUp(text: string): number {
  let net = 0;
  let s = text;
  // Repeatedly chip the LAST CSI sequence off the end until the tail
  // hits a printable. Anchored regex (`$`) keeps us strictly trailing.
  for (;;) {
    if (s.length === 0) break;
    // Bare \r contributes nothing.
    if (s.charCodeAt(s.length - 1) === 0x0d) {
      s = s.slice(0, -1);
      continue;
    }
    const m = /\x1b\[([\d;?]*)([@A-Za-z])$/.exec(s);
    if (m === null) break;
    const param = m[1] ?? '';
    const letter = m[2] ?? '';
    if (!param.startsWith('?')) {
      const head = param.length === 0 ? '1' : (param.split(';')[0] ?? '1');
      const n = Number(head);
      if (Number.isFinite(n)) {
        if (letter === 'A' || letter === 'F') net += n;
        else if (letter === 'B' || letter === 'E') net -= n;
        // Other letters (G/H/J/K/m/h/l/...) are non-row-moves; ignored.
      }
    }
    s = s.slice(0, m.index);
  }
  return Math.max(0, net);
}
