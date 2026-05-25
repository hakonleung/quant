/**
 * Public surface of the theme module. Boundary layer for everything
 * else in `apps/web/`: components import semantic tokens (via Chakra
 * `color` / `bg` props that reference `system`), and any non-Chakra
 * consumer (SVG / Canvas / xterm) reaches for the helpers here.
 *
 * Direct deep imports (e.g. `from '../theme/tokens.js'`) are tolerated
 * inside this package but discouraged elsewhere — pull from the
 * barrel so future renames stay contained.
 */

export { system } from './system.js';
export { palette, fonts } from './tokens.js';
export { buildXtermTheme } from './xterm-theme.js';
export { useTokenColor, useTokenColors } from './use-token-color.js';
