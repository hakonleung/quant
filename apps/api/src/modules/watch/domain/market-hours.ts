/**
 * Pure trading-session predicates (`docs/modules/W-0-watch.md` §5).
 *
 * Windows are expressed as inclusive open / exclusive close minute-of-day.
 * BJT for A/HK; US sessions cross UTC midnight, so we work entirely in
 * UTC and shell-shift the wall clock instead of importing tzdata.
 *
 * `isUsDst(date)` follows IETF "America/New_York" rules: DST runs from
 * 02:00 ET on the second Sunday of March until 02:00 ET on the first
 * Sunday of November. v0 ignores federal holidays — akshare returns a
 * static prev-close on those days, so triggers stay quiet.
 */

import type { WatchMarket } from '@quant/shared';

const BJT_OFFSET_MIN = 8 * 60;

function minutesOfDayUtc(date: Date, offsetMin: number): { weekday: number; minute: number } {
  const shifted = new Date(date.getTime() + offsetMin * 60_000);
  return {
    // 0 = Sunday … 6 = Saturday in the *shifted* clock.
    weekday: shifted.getUTCDay(),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function inAnyWindow(minute: number, windows: ReadonlyArray<readonly [number, number]>): boolean {
  for (const w of windows) {
    if (minute >= w[0] && minute < w[1]) return true;
  }
  return false;
}

const A_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9 * 60 + 30, 11 * 60 + 30],
  [13 * 60, 15 * 60],
];

// HK afternoon close temporarily extended to 16:10 BJT (spec §5 has 16:00).
// TODO: revert once the upstream quote-source latency campaign closes.
const HK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9 * 60 + 30, 12 * 60],
  [13 * 60, 16 * 60 + 10],
];

/**
 * Returns true iff `date` is between the second Sunday of March 02:00 ET
 * and the first Sunday of November 02:00 ET in the *local* US year.
 *
 * Implementation works in UTC. ET is UTC-5 (standard) or UTC-4 (DST), so
 * the "02:00 ET" boundary is equivalently "07:00 UTC standard" /
 * "06:00 UTC DST". We use 07:00 UTC for both edges — close enough since
 * the markets we care about don't tick across that exact minute.
 */
export function isUsDst(date: Date): boolean {
  const year = date.getUTCFullYear();
  const startUtc = nthWeekdayOfMonth(year, 2 /* March */, 0 /* Sunday */, 2);
  const endUtc = nthWeekdayOfMonth(year, 10 /* November */, 0 /* Sunday */, 1);
  startUtc.setUTCHours(7, 0, 0, 0);
  endUtc.setUTCHours(7, 0, 0, 0);
  const t = date.getTime();
  return t >= startUtc.getTime() && t < endUtc.getTime();
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}

export function isMarketOpen(market: WatchMarket, now: Date): boolean {
  if (market === 'a') {
    const { weekday, minute } = minutesOfDayUtc(now, BJT_OFFSET_MIN);
    if (weekday === 0 || weekday === 6) return false;
    return inAnyWindow(minute, A_WINDOWS);
  }
  if (market === 'hk') {
    const { weekday, minute } = minutesOfDayUtc(now, BJT_OFFSET_MIN);
    if (weekday === 0 || weekday === 6) return false;
    return inAnyWindow(minute, HK_WINDOWS);
  }
  // US: NYSE 09:30-16:00 ET.
  // ET → UTC: standard +5h (14:30-21:00 UTC); DST +4h (13:30-20:00 UTC).
  const dst = isUsDst(now);
  const offsetMin = dst ? -4 * 60 : -5 * 60;
  const { weekday, minute } = minutesOfDayUtc(now, offsetMin);
  if (weekday === 0 || weekday === 6) return false;
  return minute >= 9 * 60 + 30 && minute < 16 * 60;
}
