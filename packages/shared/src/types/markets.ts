/**
 * Market discriminators shared across processes.
 *
 * Codes are bare 6-digit strings (CLAUDE.md §2.7). Prefixes:
 *
 *   A-share (Shanghai / Shenzhen):
 *     0xx, 1xx (mostly bonds — but A 6-digit pool reserves them)
 *     3xx  → ChiNext (深市)
 *     6xx  → 主板 + 科创板 (沪市)
 *   北交所 (BSE — explicitly NOT A-share for blacklist purposes):
 *     4xx, 8xx, 920–929
 */

const A_SHARE_PREFIX = /^[03][0-9]{5}$|^6[0-9]{5}$/;

/**
 * True iff `code` is a Shanghai/Shenzhen A-share (6 digits, starts with
 * 0/3/6). 北交所 (4/8/9) returns false. Used by the blacklist filter so
 * the noise-reduction list never touches HK/US/BJ codes.
 */
export function isAShareCode(code: string): boolean {
  return A_SHARE_PREFIX.test(code);
}
