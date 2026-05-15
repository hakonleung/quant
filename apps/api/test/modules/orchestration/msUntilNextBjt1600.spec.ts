/* eslint-disable no-restricted-globals -- test-only fixture construction. */

import { msUntilNextBjt1600 } from '../../../src/modules/orchestration/cron.orchestrator.js';

describe('msUntilNextBjt1600', () => {
  it('returns positive delay before today 16:00 BJT', () => {
    // 2026-05-04 06:00 UTC = 14:00 BJT (2h before today's 16:00 BJT)
    const now = Date.UTC(2026, 4, 4, 6, 0);
    expect(msUntilNextBjt1600(now)).toBe(2 * 60 * 60_000);
  });

  it('rolls to tomorrow when past today 16:00 BJT', () => {
    // 2026-05-04 09:00 UTC = 17:00 BJT — past today's 16:00 by 1h.
    const now = Date.UTC(2026, 4, 4, 9, 0);
    const delay = msUntilNextBjt1600(now);
    // exactly 23h to tomorrow 16:00 BJT.
    expect(delay).toBe(23 * 60 * 60_000);
  });

  it('returns full day when exactly at 16:00 BJT boundary', () => {
    // 2026-05-04 08:00 UTC = 16:00 BJT — current minute is the trigger, but
    // the function returns "next" (positive), so it rolls to tomorrow.
    const now = Date.UTC(2026, 4, 4, 8, 0);
    expect(msUntilNextBjt1600(now)).toBe(24 * 60 * 60_000);
  });
});
