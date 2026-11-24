// Angebots-Scan 2.0 — honest "active today" live/next split (Datenqualität #1/#2).
//
// The ISO-week classifier (offerWeek.ts) buckets by calendar week WITH a Sunday
// rollover: on a Sunday it treats *next* calendar week as the active week so the
// app can already show the upcoming flyer. That is right for the app feed, but it
// makes the SNAPSHOT live bucket dishonest: on a Sunday a "ab Montag 08.06."
// offer (validFrom in the future) was landing in `offers`/live, while a genuinely
// active "valid through today" offer was dropped into the discarded `other`
// bucket. The real 2026-06-07 scan wrote 765 "live" offers while every large
// shop reported 0 *current* — and the REWE manual import vanished the same way.
//
// This module owns the truthful per-offer decision used by the Scan-2.0 finalize:
//   current  — active on the scan date (validFrom <= today <= validTo)
//   next     — starts after today (the hard rule: validFrom > today ⇒ not live)
//   other    — already expired (dropped from the snapshot)
//   unknown  — no usable date signal at all (caller keeps the week bucket)
//
// Date math is comparison-stable as a YYYYMMDD integer. A structured
// validityStart/End that begins with a YYYY-MM-DD date part is taken VERBATIM as
// the offer calendar day (identical to how Cheffity/Supabase read valid_from/
// valid_to), so an end-of-day "…21T23:59:59.999Z" never drifts onto the next
// Berlin day and makes an expired offer look current. `now` is reduced to its
// Europe/Berlin calendar day so "today" rolls over when local users experience
// it. When an offer has no structured validityStart/End we fall back to a German
// date parsed out of the sourceUrl / name (e.g. "ab-montag,-08.06.26") so a
// clearly future offer is never blindly treated as live.
//
// Pure + dependency-light (only the Offer type) so it is fully unit-testable.

import type { Offer } from '../../src/types/models';

const BERLIN_TZ = 'Europe/Berlin';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const berlinDateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: BERLIN_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Reduce a UTC instant (ms) to its Europe/Berlin calendar day as YYYYMMDD. */
export function berlinYmd(ms: number): number {
  if (!Number.isFinite(ms)) return NaN;
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of berlinDateParts.formatToParts(new Date(ms))) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  return year * 10000 + month * 100 + day;
}

/** YYYYMMDD → midnight-UTC ms of that date, for cheap day-count differences. */
function ymdToUtcMs(ymd: number): number {
  const year = Math.floor(ymd / 10000);
  const month = Math.floor((ymd % 10000) / 100);
  const day = ymd % 100;
  return Date.UTC(year, month - 1, day);
}

/** Whole-day distance |a - b| between two YYYYMMDD values. */
function ymdDiffDays(a: number, b: number): number {
  return Math.abs(Math.round((ymdToUtcMs(a) - ymdToUtcMs(b)) / MS_PER_DAY));
}

// A German day.month.year date: "08.06.26" / "08.06.2026". Requires BOTH dots so
// prices ("0.85") and version-ish tokens never match; the year must be 2 or 4
// digits. Day/month ranges are validated by the caller.
const GERMAN_DATE_RE = /(\d{1,2})\.(\d{1,2})\.(\d{2}(?:\d{2})?)(?!\d)/g;

function toYmd(day: number, month: number, year: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const fullYear = year < 100 ? 2000 + year : year;
  return fullYear * 10000 + month * 100 + day;
}

/** All valid German dates in a text, as YYYYMMDD, in source order. */
function parseGermanYmds(text: string): number[] {
  if (!text) return [];
  const out: number[] = [];
  for (const match of text.matchAll(GERMAN_DATE_RE)) {
    const ymd = toYmd(Number(match[1]), Number(match[2]), Number(match[3]));
    if (ymd !== null) out.push(ymd);
  }
  return out;
}

/** First German start-date (YYYYMMDD) found in a text, or null. */
export function extractGermanStartYmd(text: string): number | null {
  const ymds = parseGermanYmds(text);
  return ymds.length > 0 ? ymds[0] : null;
}

/** Combined text we mine a fallback date from when structured dates are absent. */
function offerDateText(offer: Offer): string {
  const o = offer as Offer & Record<string, unknown>;
  return [offer.sourceUrl, offer.name, offer.normalizedName, o.sourceContextRaw, o.sourceTagsRaw]
    .map((value) => (Array.isArray(value) ? value.join(' ') : String(value ?? '')))
    .join(' ');
}

// A structured validity string that BEGINS with a YYYY-MM-DD date part is an
// OFFER CALENDAR DAY, not a wall-clock instant. "2026-06-21T23:59:59.999Z"
// means the offer is valid THROUGH 2026-06-21 — exactly how Cheffity/Supabase
// read valid_from/valid_to (toDate → the YYYY-MM-DD prefix). The previous
// Date.parse → berlinYmd path converted the UTC end-of-day to the NEXT Berlin
// calendar day (+2h CEST), so a 06-21 offer looked current on 06-22. Taking the
// date part verbatim keeps the snapshot decision identical to the deal table.
const ISO_DATE_PART_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function structuredYmd(value: string | undefined): number | null {
  if (!value) return null;
  const datePart = ISO_DATE_PART_RE.exec(value);
  if (datePart) {
    const ymd = toYmd(Number(datePart[3]), Number(datePart[2]), Number(datePart[1]));
    if (ymd !== null) return ymd;
  }
  // Fallback ONLY for non-date-part values (e.g. "2026/06/21", locale strings):
  // reduce the real instant to its Europe/Berlin calendar day.
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? berlinYmd(ms) : null;
}

/** Effective start date (Berlin YYYYMMDD): structured first, else from text. */
export function offerStartYmd(offer: Offer): number | null {
  const structured = structuredYmd(offer.validityStart);
  if (structured !== null) return structured;
  const ymds = parseGermanYmds(offerDateText(offer));
  return ymds.length > 0 ? Math.min(...ymds) : null;
}

/** Effective end date (Berlin YYYYMMDD): structured first, else latest in text. */
export function offerEndYmd(offer: Offer): number | null {
  const structured = structuredYmd(offer.validityEnd);
  if (structured !== null) return structured;
  const ymds = parseGermanYmds(offerDateText(offer));
  return ymds.length >= 2 ? Math.max(...ymds) : null;
}

export type LiveWindow = 'current' | 'next' | 'other' | 'unknown';

/**
 * Decide the honest live window for one offer at `now` (Europe/Berlin). Returns
 * `unknown` only when there is NO date signal at all, so the caller can keep its
 * existing ISO-week bucket instead of guessing. `maxValidityDays` guards against
 * promoting an implausibly long "offer" (scraper noise / evergreen banner) into
 * the live feed — those degrade to `unknown` and stay where the week split put
 * them.
 */
export function classifyLiveWindow(offer: Offer, now: Date, maxValidityDays = 21): LiveWindow {
  const today = berlinYmd(now.getTime());
  const start = offerStartYmd(offer);
  const end = offerEndYmd(offer);

  if (start === null && end === null) return 'unknown';

  // Already ended → expired.
  if (end !== null && end < today) return 'other';
  // Starts after today → upcoming (the hard rule: validFrom > today ⇒ not live).
  if (start !== null && start > today) return 'next';

  // Active today. Sanity-check the span so an evergreen/over-long range is not
  // force-promoted to live; let the caller's week bucket decide that one.
  if (start !== null && end !== null && ymdDiffDays(start, end) > maxValidityDays) {
    return 'unknown';
  }
  if (start !== null && end === null && ymdDiffDays(start, today) > maxValidityDays) {
    return 'unknown';
  }
  if (start === null && end !== null && ymdDiffDays(today, end) > maxValidityDays) {
    return 'unknown';
  }
  return 'current';
}

export interface LiveWindowSplit {
  current: Offer[];
  next: Offer[];
  /** Expired offers intentionally dropped from the snapshot (never preserved). */
  dropped: Offer[];
}

export interface SplitOffersByLiveWindowOptions {
  now?: Date;
  /** ISO-week bucket fallback for offers with no date signal (`unknown`). */
  weekBucketOf?: (offer: Offer) => 'current' | 'next' | 'other';
  /** Manual-import stores (REWE/nahkauf) that must NEVER be dropped. */
  isPreserved?: (offer: Offer) => boolean;
  maxValidityDays?: number;
}

/**
 * Split offers into the honest snapshot buckets. Non-preserved offers follow
 * {@link classifyLiveWindow}; `unknown` ones fall back to the injected ISO-week
 * bucket (so date-less offers keep today's behaviour and are never silently
 * promoted into live). Preserved offers (REWE/nahkauf manual imports) are NEVER
 * dropped — an expired/date-less one stays live, a clearly future one goes to
 * next — so a scan can never make the manual import vanish.
 */
export function splitOffersByLiveWindow(
  offers: readonly Offer[],
  options: SplitOffersByLiveWindowOptions = {},
): LiveWindowSplit {
  const now = options.now ?? new Date();
  const weekBucketOf = options.weekBucketOf ?? (() => 'current');
  const isPreserved = options.isPreserved ?? (() => false);
  const maxValidityDays = options.maxValidityDays ?? 21;

  const current: Offer[] = [];
  const next: Offer[] = [];
  const dropped: Offer[] = [];

  for (const offer of offers) {
    const window = classifyLiveWindow(offer, now, maxValidityDays);

    if (isPreserved(offer)) {
      // Manual import stays visible so a scan can never make it vanish — EXCEPT
      // a genuinely expired one (valid_to < today): an offer that has already
      // ended must NEVER read as current, not even for REWE/nahkauf. A clear
      // future start goes to next; a date-less/inconclusive offer keeps current
      // (the no-signal case the preserve rule protects). Snapshot date-hygiene —
      // no shop/KW/product special-casing, just the date.
      if (window === 'other') dropped.push(offer);
      else if (window === 'next') next.push(offer);
      else current.push(offer);
      continue;
    }

    if (window === 'current') {
      current.push(offer);
    } else if (window === 'next') {
      next.push(offer);
    } else if (window === 'other') {
      dropped.push(offer);
    } else {
      // unknown → defer to the ISO-week classifier.
      const fallback = weekBucketOf(offer);
      if (fallback === 'current') current.push(offer);
      else if (fallback === 'next') next.push(offer);
      else dropped.push(offer);
    }
  }

  return { current, next, dropped };
}

export interface ActiveBucketsLike {
  offers: readonly Offer[];
  nextWeekOffers: readonly Offer[];
  filteredOffers: readonly Offer[];
}

export interface ExpiredGateResult {
  offers: Offer[];
  nextWeekOffers: Offer[];
  filteredOffers: Offer[];
  /** Offers removed from the active buckets because valid_to < today. */
  removedCount: number;
  /** Up to {@link MAX_EXPIRED_GATE_EXAMPLES} distinct removed names (diagnostics). */
  removedExamples: string[];
}

const MAX_EXPIRED_GATE_EXAMPLES = 8;

/**
 * Generic snapshot date-hygiene gate: drop genuinely expired offers (valid_to
 * strictly before the Europe/Berlin scan day) from the ACTIVE buckets
 * (`offers` = current live, `nextWeekOffers`). An offer is only removed when it
 * carries a concrete end date in the past — i.e. exactly {@link classifyLiveWindow}
 * `=== 'other'` — so a date-less or still-valid offer is never touched. The same
 * canonical engine the week split, scan report and safety gate use, so "expired"
 * means one thing everywhere; an expired end date is detected independently of
 * `maxValidityDays`.
 *
 * `filteredOffers` are left untouched: they are already out of the live feed,
 * and expired items simply stay filtered. Pure + idempotent — a second pass over
 * the result removes nothing. No shop/KW/product special-casing.
 */
export function dropExpiredFromActiveBuckets(
  buckets: ActiveBucketsLike,
  options: { now?: Date; maxValidityDays?: number } = {},
): ExpiredGateResult {
  const now = options.now ?? new Date();
  const maxValidityDays = options.maxValidityDays ?? 21;
  const removedExamples: string[] = [];
  let removedCount = 0;

  const keepActive = (offers: readonly Offer[]): Offer[] => {
    const kept: Offer[] = [];
    for (const offer of offers) {
      if (classifyLiveWindow(offer, now, maxValidityDays) === 'other') {
        removedCount += 1;
        if (
          removedExamples.length < MAX_EXPIRED_GATE_EXAMPLES &&
          !removedExamples.includes(offer.name)
        ) {
          removedExamples.push(offer.name);
        }
      } else {
        kept.push(offer);
      }
    }
    return kept;
  };

  return {
    offers: keepActive(buckets.offers),
    nextWeekOffers: keepActive(buckets.nextWeekOffers),
    filteredOffers: [...buckets.filteredOffers],
    removedCount,
    removedExamples,
  };
}
