import { describe, expect, it } from 'vitest';
import { classifyOfferWeekRange } from './offerWeek';

const anchorNow = new Date('2026-02-10T10:00:00.000Z');

describe('classifyOfferWeekRange', () => {
  it('ordnet ein aktuelles Wochenangebot als current ein', () => {
    const start = Date.parse('2026-02-09T00:00:00.000Z');
    const end = Date.parse('2026-02-15T22:59:59.000Z');

    expect(classifyOfferWeekRange(start, end, anchorNow, 'overlap', 21)).toBe('current');
  });

  it('ordnet ein Angebot ueber zwei Wochen als next ein', () => {
    const start = Date.parse('2026-02-08T23:00:00.000Z');
    const end = Date.parse('2026-02-21T22:59:59.000Z');

    expect(classifyOfferWeekRange(start, end, anchorNow, 'overlap', 21)).toBe('next');
  });

  it('ordnet im starts-Modus nur nach Startwoche ein', () => {
    const start = Date.parse('2026-02-05T00:00:00.000Z');
    const end = Date.parse('2026-02-11T22:59:59.000Z');

    expect(classifyOfferWeekRange(start, end, anchorNow, 'starts', 21)).toBe('other');
  });

  it('verwirft Dauerlaeufer ueber maxValidityDays', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const end = Date.parse('2026-12-31T23:59:59.000Z');

    expect(classifyOfferWeekRange(start, end, anchorNow, 'overlap', 21)).toBe('other');
  });

  it('schaltet am Sonntag Live auf die naechste Kalenderwoche um', () => {
    const sundayNow = new Date('2026-05-10T10:00:00.000Z');
    const oldWeekStart = Date.parse('2026-05-04T00:00:00.000Z');
    const oldWeekEnd = Date.parse('2026-05-10T23:59:59.000Z');
    const nextWeekStart = Date.parse('2026-05-11T00:00:00.000Z');
    const nextWeekEnd = Date.parse('2026-05-17T23:59:59.000Z');
    const followingWeekStart = Date.parse('2026-05-18T00:00:00.000Z');
    const followingWeekEnd = Date.parse('2026-05-24T23:59:59.000Z');

    expect(classifyOfferWeekRange(oldWeekStart, oldWeekEnd, sundayNow, 'overlap', 21)).toBe(
      'other',
    );
    expect(
      classifyOfferWeekRange(nextWeekStart, nextWeekEnd, sundayNow, 'overlap', 21),
    ).toBe('current');
    expect(
      classifyOfferWeekRange(followingWeekStart, followingWeekEnd, sundayNow, 'overlap', 21),
    ).toBe('next');
  });

  // Regression: Sunday AFTERNOON, where `now + 12h` crosses into Monday. The
  // old code shifted `currentWeek` once via the +12h on `now` AND once via the
  // Sunday rollover (double shift), so the Monday-start week landed in 'other'
  // and was discarded on startup → /api/offers returned empty.
  it('ordnet am Sonntagnachmittag die Montag-Woche als current ein (kein Doppel-Shift)', () => {
    const sundayAfternoon = new Date('2026-05-31T14:00:00.000Z'); // Sunday
    // The new Mon–Sun week starting Monday 2026-06-01.
    const mondayWeekStart = Date.parse('2026-06-01T00:00:00.000Z');
    const mondayWeekEnd = Date.parse('2026-06-07T23:59:59.999Z');
    // The week that just ended (should be 'other' after the rollover).
    const endedWeekStart = Date.parse('2026-05-25T00:00:00.000Z');
    const endedWeekEnd = Date.parse('2026-05-31T23:59:59.999Z');
    // The following week (should be 'next').
    const followingWeekStart = Date.parse('2026-06-08T00:00:00.000Z');
    const followingWeekEnd = Date.parse('2026-06-14T23:59:59.999Z');

    expect(
      classifyOfferWeekRange(mondayWeekStart, mondayWeekEnd, sundayAfternoon, 'overlap', 21),
    ).toBe('current');
    expect(
      classifyOfferWeekRange(endedWeekStart, endedWeekEnd, sundayAfternoon, 'overlap', 21),
    ).toBe('other');
    expect(
      classifyOfferWeekRange(followingWeekStart, followingWeekEnd, sundayAfternoon, 'overlap', 21),
    ).toBe('next');
  });
});
