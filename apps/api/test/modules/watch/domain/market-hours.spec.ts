import { isMarketOpen, isUsDst } from '../../../../src/modules/watch/domain/market-hours.js';

// Helper: build a UTC Date from BJT wall-clock (BJT = UTC+8).
function bjt(year: number, month1: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month1 - 1, day, hour - 8, minute));
}

// Helper: build UTC Date from ET wall clock with explicit offset (DST = -4, std = -5).
function etUtc(year: number, month1: number, day: number, hour: number, minute: number, offsetH: number): Date {
  return new Date(Date.UTC(year, month1 - 1, day, hour - offsetH, minute));
}

describe('isUsDst', () => {
  it('false in February', () => {
    expect(isUsDst(new Date(Date.UTC(2026, 1, 1, 12)))).toBe(false);
  });
  it('true in mid July', () => {
    expect(isUsDst(new Date(Date.UTC(2026, 6, 15, 12)))).toBe(true);
  });
  it('flips on second Sunday of March (2026-03-08 02:00 ET)', () => {
    // Before 07:00 UTC on the boundary → still standard.
    expect(isUsDst(new Date(Date.UTC(2026, 2, 8, 6, 59)))).toBe(false);
    // At/after 07:00 UTC → DST.
    expect(isUsDst(new Date(Date.UTC(2026, 2, 8, 7, 0)))).toBe(true);
  });
  it('flips back on first Sunday of November (2026-11-01 02:00 ET)', () => {
    expect(isUsDst(new Date(Date.UTC(2026, 10, 1, 6, 59)))).toBe(true);
    expect(isUsDst(new Date(Date.UTC(2026, 10, 1, 7, 0)))).toBe(false);
  });
});

describe('isMarketOpen A', () => {
  it('open at 09:30 BJT weekday', () => {
    expect(isMarketOpen('a', bjt(2026, 5, 4, 9, 30))).toBe(true); // Monday
  });
  it('closed at 11:30 BJT (noon break starts)', () => {
    expect(isMarketOpen('a', bjt(2026, 5, 4, 11, 30))).toBe(false);
  });
  it('open at 13:00 BJT', () => {
    expect(isMarketOpen('a', bjt(2026, 5, 4, 13, 0))).toBe(true);
  });
  it('closed at 15:00 BJT', () => {
    expect(isMarketOpen('a', bjt(2026, 5, 4, 15, 0))).toBe(false);
  });
  it('closed on Saturday', () => {
    expect(isMarketOpen('a', bjt(2026, 5, 9, 10, 0))).toBe(false);
  });
});

describe('isMarketOpen HK', () => {
  it('open at 09:30 BJT weekday', () => {
    expect(isMarketOpen('hk', bjt(2026, 5, 4, 9, 30))).toBe(true);
  });
  it('lunch break closed', () => {
    expect(isMarketOpen('hk', bjt(2026, 5, 4, 12, 30))).toBe(false);
  });
  // Afternoon close temporarily extended to 17:00 BJT (see HK_WINDOWS).
  it('open until just before 17:00', () => {
    expect(isMarketOpen('hk', bjt(2026, 5, 4, 16, 59))).toBe(true);
    expect(isMarketOpen('hk', bjt(2026, 5, 4, 17, 0))).toBe(false);
  });
});

describe('isMarketOpen US', () => {
  it('open at 09:30 ET DST (Monday in May)', () => {
    expect(isMarketOpen('us', etUtc(2026, 5, 4, 9, 30, -4))).toBe(true);
  });
  it('closed at 16:00 ET DST', () => {
    expect(isMarketOpen('us', etUtc(2026, 5, 4, 16, 0, -4))).toBe(false);
  });
  it('open at 09:30 ET standard time (January)', () => {
    expect(isMarketOpen('us', etUtc(2026, 1, 5, 9, 30, -5))).toBe(true);
  });
  it('closed on Sunday', () => {
    expect(isMarketOpen('us', etUtc(2026, 5, 3, 12, 0, -4))).toBe(false);
  });
});
