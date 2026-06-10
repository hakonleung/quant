/* eslint-disable no-restricted-globals -- test-only fixture construction. */

import { msUntilNextBjtCron } from '../../../src/modules/orchestration/cron.orchestrator.js';

describe('msUntilNextBjtCron', () => {
  it('returns positive delay before today 16:30 BJT', () => {
    // 2026-05-04 06:00 UTC = 14:00 BJT (2.5h before today's 16:30 BJT)
    const now = Date.UTC(2026, 4, 4, 6, 0);
    expect(msUntilNextBjtCron(now)).toBe(150 * 60_000);
  });

  it('rolls to tomorrow when past today 16:30 BJT', () => {
    // 2026-05-04 09:00 UTC = 17:00 BJT — past today's 16:30 by 30m.
    const now = Date.UTC(2026, 4, 4, 9, 0);
    const delay = msUntilNextBjtCron(now);
    // exactly 23.5h to tomorrow 16:30 BJT.
    expect(delay).toBe(1410 * 60_000);
  });

  it('returns full day when exactly at 16:30 BJT boundary', () => {
    // 2026-05-04 08:30 UTC = 16:30 BJT — current minute is the trigger, but
    // the function returns "next" (positive), so it rolls to tomorrow.
    const now = Date.UTC(2026, 4, 4, 8, 30);
    expect(msUntilNextBjtCron(now)).toBe(24 * 60 * 60_000);
  });
});
