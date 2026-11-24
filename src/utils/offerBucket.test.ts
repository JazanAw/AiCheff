import { describe, expect, it } from 'vitest';
import { classifyOfferBucket, summarizeOfferBuckets } from './offerBucket';

const now = new Date('2026-06-03T13:00:00.000Z');

function range(start: string, end: string) {
  return { validityStart: start, validityEnd: end };
}

describe('classifyOfferBucket', () => {
  it('marks an offer that is active today as current', () => {
    expect(
      classifyOfferBucket(range('2026-06-01T00:00:00.000Z', '2026-06-06T23:59:59.000Z'), now),
    ).toBe('current');
  });

  it('marks an offer whose validityStart is in the future as upcoming, not current', () => {
    // Starts later this week (Thu) — NOT active today (Wed), so it is upcoming.
    expect(
      classifyOfferBucket(range('2026-06-04T00:00:00.000Z', '2026-06-10T23:59:59.000Z'), now),
    ).toBe('upcoming');
    // Clearly next calendar week.
    expect(
      classifyOfferBucket(range('2026-06-08T00:00:00.000Z', '2026-06-14T23:59:59.000Z'), now),
    ).toBe('upcoming');
  });

  it('marks an offer that already ended as expired', () => {
    expect(
      classifyOfferBucket(range('2026-05-25T00:00:00.000Z', '2026-06-02T23:59:59.000Z'), now),
    ).toBe('expired');
  });

  it('treats an offer starting exactly now / today as current (boundary)', () => {
    expect(classifyOfferBucket(range('2026-06-03T00:00:00.000Z', '2026-06-09T23:59:59.000Z'), now)).toBe(
      'current',
    );
  });

  it('falls back to current when dates are missing or invalid (never hides an offer)', () => {
    expect(classifyOfferBucket({ validityStart: '', validityEnd: '' }, now)).toBe('current');
    expect(classifyOfferBucket({ validityStart: 'nope', validityEnd: 'nope' }, now)).toBe('current');
  });
});

describe('summarizeOfferBuckets', () => {
  it('counts current vs upcoming vs expired across a list', () => {
    const offers = [
      range('2026-06-01T00:00:00.000Z', '2026-06-06T23:59:59.000Z'), // current
      range('2026-06-08T00:00:00.000Z', '2026-06-14T23:59:59.000Z'), // upcoming
      range('2026-06-04T00:00:00.000Z', '2026-06-10T23:59:59.000Z'), // upcoming (not started)
      range('2026-05-25T00:00:00.000Z', '2026-06-02T23:59:59.000Z'), // expired
    ];
    expect(summarizeOfferBuckets(offers, now)).toEqual({ current: 1, upcoming: 2, expired: 1 });
  });
});
