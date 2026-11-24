// Honest "live vs upcoming" bucketing for the offer export/API.
//
// The weekly classifier (offerWeek.ts) buckets by ISO week (this week / next
// week). That is the right granularity for the app's "current week" feed, but
// it is NOT the same as "active today": an offer that starts later this week
// (validityStart > now) still falls into the current ISO week, yet it is not
// live yet. The external CSV check found ~379 such not-yet-started offers mixed
// into a file named "live_offers".
//
// classifyOfferBucket answers the honest question per offer:
//   current  — active today (validityStart <= now <= validityEnd)
//   upcoming — not started yet (validityStart > now)
//   expired  — already ended (validityEnd < now)
//
// Pure + dependency-free so it is trivially unit-testable and safe to call from
// both the export layer and the scan report. It deliberately does NOT touch the
// ISO-week snapshot buckets (offers/nextWeekOffers) — those stay for app API
// compatibility; this adds the truthful active/upcoming split on top.

export type OfferBucket = 'current' | 'upcoming' | 'expired';

export interface OfferValidityLike {
  validityStart?: string | null;
  validityEnd?: string | null;
}

export function classifyOfferBucket(
  offer: OfferValidityLike,
  now: Date = new Date(),
): OfferBucket {
  const nowMs = now.getTime();
  const startMs = Date.parse(offer.validityStart ?? '');
  const endMs = Date.parse(offer.validityEnd ?? '');

  // Already ended → expired (checked first; a valid range never has end < start).
  if (Number.isFinite(endMs) && endMs < nowMs) {
    return 'expired';
  }
  // Not started yet → upcoming, never "live".
  if (Number.isFinite(startMs) && startMs > nowMs) {
    return 'upcoming';
  }
  // Active today, or dates missing/invalid → keep it visible as current rather
  // than silently hiding it.
  return 'current';
}

export interface OfferBucketCounts {
  current: number;
  upcoming: number;
  expired: number;
}

export function summarizeOfferBuckets(
  offers: readonly OfferValidityLike[],
  now: Date = new Date(),
): OfferBucketCounts {
  const counts: OfferBucketCounts = { current: 0, upcoming: 0, expired: 0 };
  for (const offer of offers) {
    counts[classifyOfferBucket(offer, now)] += 1;
  }
  return counts;
}
