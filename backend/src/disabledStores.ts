// Stores intentionally DISABLED in the offer scan because their public source is
// currently NOT reliable enough for an automatic import.
// This is a clean, honest disable path — NOT another repair attempt for these
// shops. The DEFAULT set is currently EMPTY; operators can disable any store via
// the OFFERS_DISABLED_STORES env csv.
//
// Lidl is NO LONGER disabled: the weekly leaflet identifiers
// (`aktionsprospekt-…`) are server-rendered on the public Prospekte page
// (lidl.de/c/online-prospekte/s10005610) and resolve on the SAME public
// v4/flyer viewer JSON the manual import uses (endpoints.leaflets.schwarz).
// Only structurally priced `flyer.products` entries become offers (coverage
// stays `structured_only`, sourceCoverage `partial_with_viewer_json`, NEVER
// full); priceless fresh hotspots stay pending/diagnostic and the manual
// review import remains as the supplement for them. No private API, no login,
// no anti-bot bypass, no KW hardcodes.
//
// EDEKA is NO LONGER disabled: https://www.edeka.de/angebote serves a server-
// rendered HTML page (template "edeka_neu", HTTP 200, no login / captcha bypass)
// whose <dialog>-cards carry machine-readable sr-only price labels. The
// structured card parser (officialSupermarketConnector.parseEdekaOffers) reads
// them honestly. WITHOUT a market selection the page only exposes the NATIONAL
// offers (header id="national-offers-header") — so EDEKA is imported and reported
// as `national_only`, NEVER `full`; a blocked/captcha page is reported as
// blocked/critical, never as a silent "0 offers". See [[project-edeka-connector]].
//
// ALDI NORD is NO LONGER disabled: it is imported again through the structured
// website connector (officialSupermarketConnector.parseAldiNordApiData — the
// public __NEXT_DATA__ / apiData OFFER_GET payload), NOT via PDF/OCR/Vision.
//
// ALDI SÜD is ALSO no longer disabled: the central public Wochenangebote
// collection page returns HTTP 200 with structured products embedded in the
// Nuxt-3 __NUXT_DATA__ payload (+ DOM product tiles), paginated via ?page=2,3,….
// It imports via officialSupermarketConnector.collectAldiSuedPaginatedOffers —
// NOT via PDF/OCR/Vision, no anti-bot bypass. A blocked page is reported honestly
// (blocked/unavailable), never as a silent "0 offers". See [[disabled-stores-policy]].
//
// A DISABLED store differs from the manual-import EXCLUDED stores
// (REWE/nahkauf — see weeklyAutoScan.parseExcludedStores), which stay in the
// snapshot and arrive via Browser/PDF import. A disabled store is:
//   • never fetched (no HTTP / OCR / Vision / Publitas-Prospekt request),
//   • PURGED from every snapshot bucket (offers/nextWeek/filtered) so the App
//     and Cheffity never show its stale offers,
//   • reported as `disabled` / "not scanned by policy" (never `critical`, never
//     a Mindestmengen-Warning),
//   • explicitly expired in Cheffity/Supabase (valid_to = yesterday), respecting
//     verified/admin-protected deals.
//
// Pure + dependency-light. Store identity reuses the SAME umlaut-folded
// `normalizeChainKey` as the scope model + safety gate, so "ALDI SÜD" /
// "ALDI SUED" / "aldi süd" all collapse to one key. Matching is GENERIC by store
// chain only — never by product or brand name, never by calendar week.

import { normalizeChainKey } from './scanV2Scope';

/** Canonical display names of the stores disabled by policy (the default set).
 *  Mirrors the official-connector chain names so the scrape exclusion matches.
 *  Currently EMPTY: ALDI NORD, ALDI SÜD, EDEKA and Lidl all import via their
 *  structured public connectors again (EDEKA national_only, Lidl
 *  structured_only/partial_with_viewer_json — never full). */
export const DEFAULT_DISABLED_STORES: readonly string[] = [];

/**
 * Parse the OFFERS_DISABLED_STORES csv into a clean list of NORMALIZED chain
 * keys (umlaut-folded, lowercased). Empty input falls back to the default
 * policy set (currently empty). De-duplicated; empty entries dropped.
 */
export function parseDisabledStores(
  raw: string | undefined,
  fallback: readonly string[] = DEFAULT_DISABLED_STORES,
): string[] {
  const parts = String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const source = parts.length > 0 ? parts : fallback;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of source) {
    const key = normalizeChainKey(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * The disabled stores as human DISPLAY names (trimmed, de-duped by normalized
 * key), for the scan report / admin UI. Empty input falls back to the default
 * policy display names (currently empty) so the report always shows exactly the
 * effectively disabled shops.
 */
export function disabledStoreDisplayNames(
  raw: string | undefined,
  fallback: readonly string[] = DEFAULT_DISABLED_STORES,
): string[] {
  const parts = String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const source = parts.length > 0 ? parts : fallback;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of source) {
    const key = normalizeChainKey(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Whether a (raw or normalized) store chain is in the disabled set. */
export function isStoreDisabled(
  storeChain: string | undefined,
  disabled: readonly string[],
): boolean {
  const key = normalizeChainKey(storeChain);
  if (!key) return false;
  return disabled.some((entry) => normalizeChainKey(entry) === key);
}

export interface DisabledPurgeBuckets {
  offers: { storeChain?: string; name?: string }[];
  nextWeekOffers: { storeChain?: string; name?: string }[];
  filteredOffers: { storeChain?: string; name?: string }[];
}

export interface DisabledPurgeResult<T> {
  offers: T[];
  nextWeekOffers: T[];
  filteredOffers: T[];
  /** Total offers removed across all three buckets. */
  removedCount: number;
  /** Per (normalized) store breakdown of removed offers. */
  removedByStore: Record<string, number>;
  /** Bounded example names of removed offers (never huge lists). */
  removedExamples: string[];
}

const REMOVED_EXAMPLES_MAX = 8;

export interface PurgeDisabledOptions<T> {
  /**
   * Angebote, die trotz deaktiviertem Store ERHALTEN bleiben sollen — der
   * manuelle ALDI-PDF-Import. ALDI bleibt im Auto-Scan deaktiviert (wird nie
   * gefetcht), aber eine bewusst vom Nutzer hochgeladene PDF darf nicht durch
   * den generischen Disabled-Purge sofort wieder verschwinden. Default: nichts
   * erhalten (Verhalten wie bisher).
   */
  isPreserved?: (offer: T) => boolean;
}

/**
 * Remove every disabled-store offer from all snapshot buckets. Generic (matches
 * by store chain only) and idempotent: a snapshot that already contains no
 * disabled store passes through unchanged with `removedCount === 0`. This is the
 * single reconciliation step that keeps a fresh scan — and every boot/save —
 * from leaving stale ALDI/Lidl offers in `offers` / `nextWeekOffers` /
 * `filteredOffers`.
 *
 * `options.isPreserved` schützt einzelne Angebote (manueller ALDI-PDF-Import)
 * vor dem Purge, OHNE die Auto-Scan-Deaktivierung aufzuweichen — kein Fetch,
 * aber ein bewusst hochgeladenes PDF bleibt erhalten.
 */
export function purgeDisabledFromBuckets<
  T extends { storeChain?: string; name?: string },
>(
  buckets: { offers: T[]; nextWeekOffers: T[]; filteredOffers: T[] },
  disabled: readonly string[],
  options: PurgeDisabledOptions<T> = {},
): DisabledPurgeResult<T> {
  const isPreserved = options.isPreserved ?? (() => false);
  const removedByStore: Record<string, number> = {};
  const removedExamples: string[] = [];
  let removedCount = 0;

  const keep = (offers: readonly T[]): T[] => {
    const out: T[] = [];
    for (const offer of offers) {
      if (isStoreDisabled(offer.storeChain, disabled) && !isPreserved(offer)) {
        removedCount += 1;
        const key = normalizeChainKey(offer.storeChain);
        removedByStore[key] = (removedByStore[key] ?? 0) + 1;
        const name = String(offer.name ?? '').trim();
        if (name && removedExamples.length < REMOVED_EXAMPLES_MAX && !removedExamples.includes(name)) {
          removedExamples.push(name);
        }
        continue;
      }
      out.push(offer);
    }
    return out;
  };

  return {
    offers: keep(buckets.offers),
    nextWeekOffers: keep(buckets.nextWeekOffers),
    filteredOffers: keep(buckets.filteredOffers),
    removedCount,
    removedByStore,
    removedExamples,
  };
}
