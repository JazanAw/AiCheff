// Pushes the backend offers snapshot into the Supabase `public.deals` table
// so the Admin Panel and other Supabase-connected clients can see them.
//
// Uses the Service-Role key from SUPABASE_SERVICE_ROLE_KEY env var. The key
// bypasses all RLS — keep it backend-only.
//
// Strategy: upsert by (source, source_external_id) — the deals table has a
// unique constraint on that pair. Old offers that aren't in the new snapshot
// are not deleted; their `valid_to` will naturally have them filtered out.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Offer } from '../../../src/types/models';
import type { OfferScopeMap } from '../store/offersStore';
import { deriveDealEnrichment } from '../dealFields';
import { articleIdForOffer } from '../../../src/utils/articleIdentity';
import { normalizeText } from '../../../src/utils/offers';

// Known deal-source values. Must stay in sync with the `deals.source` CHECK
// constraint defined in supabase/migrations/20260527000001_deals_source_values.sql.
export type DealSource =
  | 'official'             // OfficialSupermarketSourceConnector (live scrape)
  | 'local_ocr'            // LocalMarketConnector (OCR of Prospekt PDFs/images)
  | 'manual_rewe_import'   // Manual REWE screenshot/PDF/browser bookmarklet
  | 'manual'               // Fallback for other manual paths
  | 'marktguru'            // Legacy — kept for migration compatibility only
  | 'kaufda';              // Legacy — kept for migration compatibility only

/**
 * Derive the canonical `deals.source` value from an offer.
 *
 * Mapping is based on the stable ID prefix produced by each connector — see
 * `stableOfficialId`, `stableLocalOfferId`, `stableReweImportId`. The prefix
 * is the only reliable provenance marker on the Offer model itself (Offer
 * has no `provenance` field). When the prefix is unknown we conservatively
 * fall back to 'manual' instead of poisoning the table with the wrong source.
 */
export function deriveDealSource(offer: Pick<Offer, 'id'>): DealSource {
  const id = offer.id ?? '';

  if (id.startsWith('official_')) {
    return 'official';
  }
  if (id.startsWith('local_')) {
    return 'local_ocr';
  }
  if (id.startsWith('rewe_browser_')) {
    return 'manual_rewe_import';
  }

  // Unknown provenance (e.g. fixture/extracted `offer_<hash>` IDs from the
  // chunk pipeline, or imports we have not classified). 'manual' is the
  // safest bucket: it does not falsely claim a live-scrape origin and was
  // already an accepted source in the original CHECK constraint.
  return 'manual';
}

/** Separator between the normalized store and the original connector offer id
 *  inside a store-scoped `source_external_id`. `normalizeStoreKey` strips every
 *  `:` from the store part, so a `::` in the value is always THIS separator and
 *  the original id is `value.split('::').slice(1).join('::')`. */
export const STORE_SCOPED_ID_SEP = '::';

/**
 * Stable, collision-resistant key for a store. Reuses `normalizeText`
 * (umlaut-transliterated, lowercased, punctuation-stripped) and folds runs of
 * whitespace to `_`, so "REWE" → `rewe`, "ALDI NORD" → `aldi_nord`,
 * "nahkauf" → `nahkauf`. Empty/unknown stores fall back to `unbekannt`, mirroring
 * the `store_name` default in `offerToDealRow`.
 */
export function normalizeStoreKey(storeName: string | undefined | null): string {
  const norm = normalizeText(String(storeName ?? '')).replace(/\s+/g, '_');
  return norm || 'unbekannt';
}

/**
 * Build the store-scoped `source_external_id` written to `deals` (and mirrored
 * into `offer_history`).
 *
 * ROOT CAUSE this fixes: the connector offer id (e.g. `official_coq5xx`) is NOT
 * globally unique — REWE and nahkauf can emit the SAME `official_…` id for two
 * physically different offers. The `deals` unique key is
 * `(source, source_external_id)` with NO `store_name`, so those two offers
 * collide on upsert and one store's deal silently vanishes (the nahkauf
 * "missing 22" symptom). Prefixing the normalized store makes the key
 * per-store: `nahkauf::official_coq5xx` vs `rewe::official_coq5xx` are two rows.
 *
 * The original id stays recoverable (suffix after `::`, and the full offer is in
 * `deals.raw_payload`). A genuine in-store duplicate still produces the SAME
 * scoped id, so `dedupeDealRows` keeps collapsing real duplicates.
 */
export function storeScopedExternalId(offer: Pick<Offer, 'id' | 'storeChain'>): string {
  return `${normalizeStoreKey(offer.storeChain)}${STORE_SCOPED_ID_SEP}${offer.id ?? ''}`;
}

type DealCategory =
  | 'fruits_vegetables' | 'meat_fish' | 'dairy' | 'bakery' | 'drinks'
  | 'snacks_sweets' | 'pantry' | 'ready_meals' | 'frozen' | 'other';

type Allergen =
  | 'gluten' | 'lactose' | 'nuts' | 'eggs' | 'soy'
  | 'fish' | 'seafood' | 'sesame';

interface DealRow {
  source: DealSource;
  source_external_id: string;
  /** Produktfamilien-Identität (articleIdForOffer) — siehe Migration
   *  20260817000002_deal_article_id. Anker für Favoriten, die einen
   *  Wochenwechsel überleben müssen. */
  article_id: string;
  name: string;
  store_name: string;
  store_logo_url?: string | null;
  category: DealCategory;
  current_price: number;
  original_price?: number | null;
  savings_percent?: number | null;
  image_url: string | null;
  valid_from: string;  // YYYY-MM-DD
  valid_to: string;
  is_national: boolean;
  region_postal_code: string | null;
  region_country: string;
  ingredients: string[];
  is_food: boolean | null;
  is_halal: boolean | null;
  contains_alcohol: boolean | null;
  allergens: Allergen[];
  nutrition: unknown | null;
  raw_payload: unknown;
  scanned_at: string;
}

export interface SyncResult {
  attempted: number;
  upserted: number;
  skipped: number;
  errors: string[];
  durationMs: number;
  /** Old active deals (for a store that IS part of this snapshot) whose
   *  source_external_id is no longer present — collapsed to an expired
   *  validity window so Cheffity-current matches the snapshot exactly. */
  staleExpired: number;
  /** Per-store breakdown of the expired stale deals. */
  staleByStore: Record<string, number>;
  /** Errors from the stale-cleanup pass — kept SEPARATE from upsert errors so
   *  a cleanup hiccup is not confused with a failed upsert. */
  staleExpireErrors: string[];
  /** Offers that collapsed onto an already-seen (source, source_external_id)
   *  and were dropped before upsert. Without this they would overwrite each
   *  other in the table (the unique key has no store_name) and a store's deal
   *  would silently vanish. */
  collisions: number;
  /** Up to 20 human-readable collision samples — cross-store ones (the
   *  explanatory case, e.g. nahkauf vs REWE) are listed first. */
  collisionSamples: string[];
  /** current-bucket offers whose `validityStart` was still in the future and
   *  were clamped to `valid_from = today` so Cheffity reads them as current.
   *  This is the count that proves the bucket-dominant fix is firing. */
  currentBucketForcedTodayCount: number;
  /** nextWeek-bucket offers with a missing or non-future `validityStart` whose
   *  `valid_from` was forced to the future fallback (today+1) so they never
   *  read as current. */
  futureBucketForcedTomorrowCount: number;
  /** Active deals of stores DISABLED by policy (ALDI SÜD/NORD, Lidl) that were
   *  collapsed to an expired validity window so Cheffity stops showing them. Kept
   *  SEPARATE from the normal stale-cleanup (those stores are not in the
   *  snapshot at all). Verified/admin deals are never touched. */
  disabledExpired: number;
  /** Per-store breakdown of the expired disabled-store deals. */
  disabledByStore: Record<string, number>;
  /** Errors from the disabled-store expire pass (kept separate). */
  disabledExpireErrors: string[];
}

let cachedClient: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  cachedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedClient;
}

// Maps the rich Python taxonomy main categories (taxonomy.yaml) onto the
// coarse mobile-facing DealCategory union the app actually supports. Meat & fish
// collapse into `meat_fish`, alcoholic + non-alcoholic drinks into `drinks`, and
// Backwaren -> bakery, Grundnahrung + Gewuerze/Saucen -> pantry,
// Konserven/Fertiggerichte + Feinkost -> ready_meals (Migration
// 20260819000001). Identisch zu mobile/src/services/dealCategory.ts.
const CANONICAL_MAIN_TO_DEAL: Record<string, DealCategory> = {
  'Obst & Gemüse': 'fruits_vegetables',
  'Fleisch & Wurst': 'meat_fish',
  'Fisch & Meeresfrüchte': 'meat_fish',
  'Milchprodukte & Eier': 'dairy',
  'Getränke alkoholfrei': 'drinks',
  Alkohol: 'drinks',
  'Süßwaren & Snacks': 'snacks_sweets',
  Tiefkühl: 'frozen',
  Backwaren: 'bakery',
  Grundnahrungsmittel: 'pantry',
  'Konserven & Fertiggerichte': 'ready_meals',
  'Gewürze/Saucen/Aufstriche': 'pantry',
  'Feinkost & Kühlung': 'ready_meals',
  'Non-Food': 'other',
};

export function mapCategory(
  rawCategory: string,
  name: string,
  tags: string[] = [],
  canonical?: { main?: string; isNonFood?: boolean; confidence?: number },
): DealCategory {
  // 1) Prefer the KI/rule canonical category — but only when it is a confident
  //    classification. Earlier this used snake_case keys that never matched the
  //    real Python mains ("Obst & Gemüse" …), so it silently fell through.
  if (canonical?.isNonFood === true) {
    return 'other';
  }
  const canonicalMain = String(canonical?.main ?? '').trim().normalize('NFC');
  const confidence = Number(canonical?.confidence);
  if (canonicalMain && Number.isFinite(confidence) && confidence >= 0.7) {
    const mapped = CANONICAL_MAIN_TO_DEAL[canonicalMain];
    if (mapped) {
      return mapped;
    }
  }

  // 2) Fallback: regex on the source category + name + tags.
  const source = `${rawCategory} ${name} ${tags.join(' ')}`
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

  if (/obst|gemuese|gemuse|frucht|salat|tomate|apfel|banane|kartoffel|spargel|artischock/.test(source)) {
    return 'fruits_vegetables';
  }
  if (/fleisch|fisch|wurst|schinken|lachs|thunfisch|haehnchen|huhn|rind|schwein/.test(source)) {
    return 'meat_fish';
  }
  if (/tiefkuehl|tiefkühl|frozen|tk-|pizza/.test(source)) {
    return 'frozen';
  }
  if (/milch|kaese|käse|joghurt|quark|butter|sahne|mozzarella/.test(source)) {
    return 'dairy';
  }
  if (/getraenk|getränk|wasser|saft|cola|limonade|bier|wein|kaffee|tee|gordon|krombacher/.test(source)) {
    return 'drinks';
  }
  if (/snack|suess|süß|schokolade|chips|keks|bonbon|eis|berliner|ruehrkuchen/.test(source)) {
    return 'snacks_sweets';
  }
  return 'other';
}

function toDate(value: string | undefined): string | null {
  if (!value) return null;
  // Accept ISO datetime or YYYY-MM-DD; extract date part.
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : null;
}

/**
 * Date part (YYYY-MM-DD) of `now` in **Europe/Berlin**, not UTC.
 *
 * ROOT CAUSE this fixes: the previous `now.toISOString().slice(0, 10)` used the
 * UTC date. Between midnight and 02:00 Berlin (CEST = UTC+2) the UTC date is
 * still YESTERDAY, so a sync started shortly after midnight stamped every
 * `valid_from` one day into the past. The 2026-06-22 REWE import produced 103
 * rows with `valid_from = valid_to = 2026-06-21` exactly this way. The offers
 * are German retail promos on a German calendar week, so Berlin — never UTC —
 * is the only correct "today".
 */
function todayDate(now: Date): string {
  // en-CA renders as YYYY-MM-DD, which is already the storage format.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Add whole days to a YYYY-MM-DD string. Pure date arithmetic on the date part
 *  only, so it cannot drift across a DST boundary the way `+ 24h` on a Date can. */
function addDaysToDateOnly(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** Conservative future marker (the day after `now` in Berlin). Used as the
 *  valid_from fallback for a nextWeek offer that has no explicit validityStart,
 *  so that `valid_from > today` holds and the deal is never read as live. */
function futureFallbackDate(now: Date): string {
  return addDaysToDateOnly(todayDate(now), 1);
}

/**
 * Length of the promo window we fall back to when an offer's own `validityEnd`
 * is missing or provably stale. 6 means a 7-day inclusive window (Mon–Sun),
 * which is what German weekly promos overwhelmingly are: 56 % of all rows ever
 * written carry exactly this span, by far the largest group.
 */
export const DEFAULT_DEAL_WINDOW_DAYS = 6;

/** Why a `valid_to` had to be derived instead of taken from the offer.
 *  `null` = the offer's own `validityEnd` was used unchanged. */
export type ValidToSource = 'missing_end' | 'stale_end' | null;

export interface ResolvedValidTo {
  validTo: string; // YYYY-MM-DD
  derived: ValidToSource;
}

/**
 * Resolve the `valid_to` written to Supabase.
 *
 * ROOT CAUSE this fixes: the old one-liner was
 *
 *     const validTo = validToParsed && validToParsed >= validFrom ? validToParsed : validFrom;
 *
 * i.e. whenever `validityEnd` was missing OR older than the (possibly clamped)
 * `valid_from`, `valid_to` silently COLLAPSED onto `valid_from`. That satisfies
 * the `valid_to >= valid_from` CHECK constraint, but produces a ZERO-DAY window:
 * the deal is born already expiring and vanishes from Cheffity the same evening.
 * Measured on production: 3.178 of 14.174 rows (22,4 %) carried such a window,
 * REWE 178 of 717 (24,8 %). The identical offers in `offer_history` — written in
 * the same sync from the same array, but without this clamp — had 0 %, which
 * proves the source data was fine and only this write path was broken.
 *
 * The stale-end case is a real contradiction: the snapshot bucket says "next
 * week" while the offer still carries last week's end date. The bucket already
 * wins for `valid_from` (see {@link resolveValidFrom}); for consistency it must
 * win for the end too, otherwise the two halves of the same window disagree.
 *
 * Rules:
 *   • `validityEnd` present and >= `validFrom` → keep it (`derived: null`).
 *   • `validityEnd` missing/unparseable        → `validFrom` + {@link DEFAULT_DEAL_WINDOW_DAYS} (`missing_end`).
 *   • `validityEnd` older than `validFrom`     → `validFrom` + {@link DEFAULT_DEAL_WINDOW_DAYS} (`stale_end`).
 *
 * The invariant `valid_to >= valid_from` still holds in every branch, so the DB
 * CHECK constraint can never be violated. Pure, no IO, no calendar-week logic,
 * no product/brand lists — only the offer, the resolved start and the fallback.
 */
export function resolveValidTo(
  validityEnd: string | undefined,
  validFrom: string,
  ): ResolvedValidTo {
  const parsed = toDate(validityEnd);

  if (!parsed) {
    return {
      validTo: addDaysToDateOnly(validFrom, DEFAULT_DEAL_WINDOW_DAYS),
      derived: 'missing_end',
    };
  }
  if (parsed < validFrom) {
    return {
      validTo: addDaysToDateOnly(validFrom, DEFAULT_DEAL_WINDOW_DAYS),
      derived: 'stale_end',
    };
  }
  return { validTo: parsed, derived: null };
}

/** Which snapshot bucket an offer was synced from. Drives ONLY the valid_from
 *  fallback safety — never any UI or matching behaviour. */
export type OfferSyncBucket = 'current' | 'next';

/** Why a `valid_from` was overridden away from the offer's own `validityStart`.
 *  Surfaced as sync diagnostics so we can SEE that the bucket-dominant rule
 *  actually fired. `null` = validityStart (or the plain bucket fallback) was
 *  used as-is, nothing was forced. */
export type ValidFromForce = 'current_forced_today' | 'next_forced_tomorrow' | null;

export interface ResolvedValidFrom {
  validFrom: string; // YYYY-MM-DD
  forced: ValidFromForce;
}

/**
 * Resolve the `valid_from` written to Supabase.
 *
 * The SNAPSHOT BUCKET is the source of truth for Cheffity current/future — it
 * dominates a stale `validityStart`. The previous rule let any parseable
 * `validityStart` win, so a current-bucket offer whose `validityStart` was
 * still in the future (an item that `splitOffersByWeek` has since moved into
 * `snapshot.offers`) kept `valid_from > today` and Cheffity wrongly read it as
 * future. The new rule:
 *
 * - bucket `current`: `valid_from` must NEVER be > today.
 *     • `validityStart <= today`            → keep it.
 *     • `validityStart` in the future        → clamp to today (forced).
 *     • no/unparseable `validityStart`       → today (unchanged, not "forced").
 * - bucket `next`: `valid_from` must ALWAYS be strictly future.
 *     • `validityStart > today`              → keep it.
 *     • `validityStart <= today` (wrong)     → future fallback today+1 (forced).
 *     • no/unparseable `validityStart`       → future fallback today+1 (forced).
 *
 * Both the backend quality report (`isFutureDeal`) and mobile
 * (`isIngredientDealFuture`) read `valid_from <= today` as "already started",
 * so the clamps keep Cheffity current/future aligned with the snapshot bucket.
 * No calendar-week logic, no hardcoded dates, no product/brand lists — only the
 * bucket + now.
 */
export function resolveValidFrom(
  validityStart: string | undefined,
  bucket: OfferSyncBucket,
  now: Date,
): ResolvedValidFrom {
  const parsed = toDate(validityStart);
  const today = todayDate(now);

  if (bucket === 'current') {
    if (parsed && parsed <= today) {
      return { validFrom: parsed, forced: null };
    }
    // Missing start is the conservative-today case (not "forced"); a future
    // start is the bug we now correct — clamp to today and flag it.
    return { validFrom: today, forced: parsed ? 'current_forced_today' : null };
  }

  // bucket === 'next'
  if (parsed && parsed > today) {
    return { validFrom: parsed, forced: null };
  }
  // No start OR a non-future start: nextWeek must never read as current.
  return { validFrom: futureFallbackDate(now), forced: 'next_forced_tomorrow' };
}

/**
 * Absolutisiert eine RELATIVE Backend-Bild-URL (z. B. die Lidl-Kachel-Crops
 * `/lidl-hotspot-crops/…`) für externe Konsumenten (Supabase → Mobile-App):
 * die App kennt den Backend-Host nicht, eine relative URL wäre dort ein
 * kaputtes Bild. Basis kommt aus DEALS_IMAGE_BASE_URL (z. B.
 * `http://192.168.1.20:8787`); ohne Basis bleibt die URL unverändert (ehrlich —
 * lieber sichtbar kaputt als ein falsch geratener Host). Absolute URLs
 * (CDN-Assets der Händler) passieren unverändert.
 */
export function absolutizeDealImageUrl(
  imageUrl: string | undefined,
  baseUrl: string | undefined = process.env.DEALS_IMAGE_BASE_URL,
): string | null {
  const url = String(imageUrl ?? '').trim();
  if (!url) return null;
  if (!url.startsWith('/')) return url;
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base || !/^https?:\/\//i.test(base)) return url;
  return `${base}${url}`;
}

export function offerToDealRow(
  offer: Offer & Record<string, unknown>,
  offerScopes: OfferScopeMap,
  bucket: OfferSyncBucket,
  now: Date = new Date(),
): DealRow {
  const canonical = offer.canonicalCategory as
    | { isNonFood?: boolean; main?: string; confidence?: number }
    | undefined;
  const foodFlag = offer.foodFlag as string | undefined;
  // Normalized deal fields (savings, allergens array, halal/alcohol, ingredients,
  // store logo) — shared with the mobile API serializer so both stay in sync.
  const enrichment = deriveDealEnrichment(offer);
  const nutrition = (offer.nutrition as unknown) ?? null;

  const scope = offerScopes[offer.id];
  const isNational =
    offer.sourceScope === 'national' ||
    (scope?.national === true && scope.local !== true);

  const { validFrom } = resolveValidFrom(offer.validityStart, bucket, now);
  // Never collapse onto validFrom — that produced the zero-day windows that made
  // 22 % of all rows expire the day they were written. See resolveValidTo.
  const { validTo } = resolveValidTo(offer.validityEnd, validFrom);

  let isFood: boolean | null = null;
  if (canonical?.isNonFood === true || foodFlag === 'nonfood') isFood = false;
  else if (foodFlag === 'food') isFood = true;

  return {
    source: deriveDealSource(offer),
    // Store-scoped so REWE and nahkauf with the same connector id don't collide
    // on the (source, source_external_id) unique key — see storeScopedExternalId.
    source_external_id: storeScopedExternalId(offer),
    // Wochenstabiler Produkt-Anker NEBEN der volatilen source_external_id: Lidl
    // und ALDI NORD legen pro Aktionswoche eine neue Produktseite an, wodurch
    // `offer.id` (und damit die external id) für dieselbe Ware wechselt. Die
    // articleId überlebt das (99,3 % wochenstabil gemessen) und trägt die
    // Favoriten über den Wochenwechsel — auch kettenübergreifend.
    article_id: articleIdForOffer(offer),
    name: offer.name || '(ohne Name)',
    store_name: offer.storeChain || 'Unbekannt',
    store_logo_url: enrichment.storeLogoUrl,
    category: mapCategory(offer.category, offer.name, offer.tags ?? [], canonical),
    current_price: Number.isFinite(offer.price) ? Number(offer.price) : 0,
    original_price: enrichment.originalPrice,
    savings_percent: enrichment.savingsPercent,
    image_url: absolutizeDealImageUrl(offer.imageUrl),
    valid_from: validFrom,
    valid_to: validTo,
    is_national: Boolean(isNational),
    region_postal_code: offer.postalCode ?? null,
    region_country: 'DE',
    ingredients: enrichment.ingredients,
    is_food: isFood,
    is_halal: enrichment.isHalal,
    contains_alcohol: enrichment.containsAlcohol,
    allergens: enrichment.allergens,
    nutrition,
    raw_payload: offer,
    scanned_at: now.toISOString(),
  };
}

export function isSupabaseSyncConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export interface SyncOptions {
  /**
   * IDs of offers that came from `snapshot.nextWeekOffers` (the upcoming week),
   * as opposed to `snapshot.offers` (the current week). Used ONLY for the
   * valid_from fallback: a nextWeek offer without an explicit `validityStart`
   * must not collapse to `valid_from = today`. Has no effect on offers that
   * carry a real start date. Defaults to empty (all treated as current bucket).
   */
  nextWeekOfferIds?: ReadonlySet<string>;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /** Injectable Supabase client for deterministic tests. Defaults to the
   *  cached service-role client built from env. */
  client?: SupabaseClient;
  /** Stores DISABLED by policy (ALDI SÜD/NORD, Lidl). Their old ACTIVE deals are
   *  collapsed to an expired validity window after the upsert so Cheffity stops
   *  showing them — even though they are no longer part of the snapshot. No
   *  deletes; verified/admin deals are respected. */
  disabledStores?: readonly string[];
}

/** Result of the post-upsert stale-cleanup pass on the `deals` table. */
export interface StaleCleanupResult {
  staleExpired: number;
  staleByStore: Record<string, number>;
  errors: string[];
}

/** Outcome of deduping the built deal rows before upsert. */
export interface DedupeResult {
  rows: DealRow[];
  collisions: number;
  /** Cross-store collision samples (store A ⟷ store B) — the explanatory case. */
  collisionSamples: string[];
}

/**
 * Collapse the built rows onto the table's unique key `(source,
 * source_external_id)`. Two offers that share that key would otherwise
 *   (a) crash the upsert batch with "ON CONFLICT ... cannot affect row a
 *       second time", and
 *   (b) silently overwrite each other so a store's deal vanishes.
 *
 * Since `source_external_id` is now STORE-SCOPED (see storeScopedExternalId),
 * REWE and nahkauf sharing a connector id produce DIFFERENT keys and no longer
 * collide here — that cross-store case (the nahkauf "missing 22" symptom) is
 * fixed at the key level. What remains is a genuine IN-STORE duplicate (the same
 * offer id twice for one store), which still collapses to its FIRST occurrence
 * (stable, deterministic). Every dropped duplicate is reported; a cross-store
 * drop would now be a real anomaly (two stores normalizing to one key) and is
 * still sampled first. Pure — no IO.
 */
export function dedupeDealRows(built: DealRow[]): DedupeResult {
  const byKey = new Map<string, DealRow>();
  const crossStoreSamples: string[] = [];
  const sameStoreSamples: string[] = [];
  let collisions = 0;
  for (const row of built) {
    const key = `${row.source} ${row.source_external_id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    collisions += 1;
    if (existing.store_name !== row.store_name) {
      if (crossStoreSamples.length < 20) {
        crossStoreSamples.push(
          `${row.source}:${row.source_external_id} (${existing.store_name} ⟷ ${row.store_name})`,
        );
      }
    } else if (sameStoreSamples.length < 20) {
      sameStoreSamples.push(`${row.source}:${row.source_external_id} (${row.store_name})`);
    }
  }
  const collisionSamples = [...crossStoreSamples, ...sameStoreSamples].slice(0, 20);
  return { rows: [...byKey.values()], collisions, collisionSamples };
}

/** Page size for reading existing active deals during stale-cleanup. */
const STALE_READ_PAGE = 1000;
/** Hard safety cap on rows scanned during stale-cleanup. */
const STALE_READ_MAX = 100_000;
/** How many ids go into one `.in('id', [...])` UPDATE — keeps the PostgREST
 *  query string short enough to never hit a 400 ("Bad Request"). */
const STALE_UPDATE_CHUNK = 100;

interface ExistingDealRow {
  id: string;
  store_name: string;
  source: string;
  source_external_id: string;
  is_verified: boolean;
}

/**
 * Expire old active deals that fell out of the current snapshot.
 *
 * After the upsert, for every store that IS part of this snapshot we read the
 * still-active deals (`valid_to >= today`) and collapse the validity window of
 * any whose `source_external_id` is NOT in the snapshot (current + nextWeek)
 * down to yesterday — so they are neither Cheffity-current nor future. Both
 * dates are set so the `valid_to >= valid_from` CHECK constraint holds and no
 * real data is deleted.
 *
 * Guardrails:
 *  - Scoped to the stores present in `syncedRows` — stores absent from this
 *    snapshot are never touched.
 *  - `is_verified = true` deals (admin-curated) are never touched.
 *  - Updates are chunked, so a large stale set never produces a too-long
 *    PostgREST request (no `Bad Request`).
 */
export async function expireStaleDeals(
  client: SupabaseClient,
  syncedRows: Array<Pick<DealRow, 'store_name' | 'source_external_id'>>,
  now: Date = new Date(),
): Promise<StaleCleanupResult> {
  const out: StaleCleanupResult = { staleExpired: 0, staleByStore: {}, errors: [] };
  const today = todayDate(now);
  // Berlin, consistent with `today` above — a UTC-derived yesterday would be
  // TWO days back between 00:00 and 02:00 Berlin (CEST), silently over-expiring.
  const yesterday = addDaysToDateOnly(todayDate(now), -1);

  // Every offer we just upserted (current AND nextWeek) must stay active.
  const keptByStore = new Map<string, Set<string>>();
  for (const r of syncedRows) {
    let set = keptByStore.get(r.store_name);
    if (!set) {
      set = new Set();
      keptByStore.set(r.store_name, set);
    }
    set.add(r.source_external_id);
  }
  const stores = [...keptByStore.keys()];
  if (stores.length === 0) return out;

  // Read existing not-yet-expired deals for exactly the snapshot's stores.
  const existing: ExistingDealRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from('deals')
      .select('id, store_name, source, source_external_id, is_verified')
      .gte('valid_to', today)
      .in('store_name', stores)
      .order('id', { ascending: true })
      .range(from, from + STALE_READ_PAGE - 1);
    if (error) {
      out.errors.push(`stale-read: ${error.message}`);
      return out;
    }
    const batch = (data ?? []) as unknown as ExistingDealRow[];
    existing.push(...batch);
    if (batch.length < STALE_READ_PAGE) break;
    from += STALE_READ_PAGE;
    if (existing.length >= STALE_READ_MAX) break;
  }

  // Identify stale ids (store in snapshot, id no longer present, not verified).
  const staleIds: string[] = [];
  const storeById = new Map<string, string>();
  for (const d of existing) {
    if (d.is_verified) continue; // never touch admin-curated deals
    const kept = keptByStore.get(d.store_name);
    if (kept && kept.has(d.source_external_id)) continue; // still in snapshot
    staleIds.push(d.id);
    storeById.set(d.id, d.store_name);
  }

  // Collapse the validity window to yesterday, chunked to stay under the
  // PostgREST URL-length limit. Count per store only on a successful chunk.
  for (let i = 0; i < staleIds.length; i += STALE_UPDATE_CHUNK) {
    const chunk = staleIds.slice(i, i + STALE_UPDATE_CHUNK);
    const { error } = await client
      .from('deals')
      .update({ valid_from: yesterday, valid_to: yesterday })
      .in('id', chunk);
    if (error) {
      out.errors.push(`stale-expire ${i}-${i + chunk.length}: ${error.message}`);
      continue;
    }
    out.staleExpired += chunk.length;
    for (const id of chunk) {
      const store = storeById.get(id) ?? 'Unbekannt';
      out.staleByStore[store] = (out.staleByStore[store] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * Expire the still-active deals of stores DISABLED by policy (ALDI SÜD/NORD,
 * Lidl). Unlike {@link expireStaleDeals} — which only touches stores PRESENT in
 * the snapshot — a disabled store is intentionally absent, so its old deals would
 * otherwise stay Cheffity-current forever. We collapse every active, non-verified
 * deal whose normalized store matches the disabled set down to yesterday.
 *
 * Generic (matched by normalized store key only — never product names),
 * idempotent (a second run finds nothing active), and non-destructive:
 *  - `is_verified = true` deals (admin-curated) are never touched.
 *  - No rows are deleted; only the validity window is collapsed.
 *  - Updates are chunked to stay under the PostgREST URL-length limit.
 */
export async function expireDisabledStoreDeals(
  client: SupabaseClient,
  disabledStores: readonly string[],
  now: Date = new Date(),
): Promise<StaleCleanupResult> {
  const out: StaleCleanupResult = { staleExpired: 0, staleByStore: {}, errors: [] };
  const disabledKeys = new Set(
    disabledStores.map((store) => normalizeStoreKey(store)).filter((key) => key && key !== 'unbekannt'),
  );
  if (disabledKeys.size === 0) return out;

  const today = todayDate(now);
  // Berlin, consistent with `today` above — a UTC-derived yesterday would be
  // TWO days back between 00:00 and 02:00 Berlin (CEST), silently over-expiring.
  const yesterday = addDaysToDateOnly(todayDate(now), -1);

  // Read existing not-yet-expired deals (paged + capped). We cannot reliably
  // filter by store_name server-side (casing/umlaut variants), so we read the
  // active set and match on the normalized key in memory.
  const existing: ExistingDealRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from('deals')
      .select('id, store_name, source, source_external_id, is_verified')
      .gte('valid_to', today)
      .order('id', { ascending: true })
      .range(from, from + STALE_READ_PAGE - 1);
    if (error) {
      out.errors.push(`disabled-read: ${error.message}`);
      return out;
    }
    const batch = (data ?? []) as unknown as ExistingDealRow[];
    existing.push(...batch);
    if (batch.length < STALE_READ_PAGE) break;
    from += STALE_READ_PAGE;
    if (existing.length >= STALE_READ_MAX) break;
  }

  const staleIds: string[] = [];
  const storeById = new Map<string, string>();
  for (const d of existing) {
    if (d.is_verified) continue; // never touch admin-curated deals
    if (!disabledKeys.has(normalizeStoreKey(d.store_name))) continue;
    staleIds.push(d.id);
    storeById.set(d.id, d.store_name);
  }

  for (let i = 0; i < staleIds.length; i += STALE_UPDATE_CHUNK) {
    const chunk = staleIds.slice(i, i + STALE_UPDATE_CHUNK);
    const { error } = await client
      .from('deals')
      .update({ valid_from: yesterday, valid_to: yesterday })
      .in('id', chunk);
    if (error) {
      out.errors.push(`disabled-expire ${i}-${i + chunk.length}: ${error.message}`);
      continue;
    }
    out.staleExpired += chunk.length;
    for (const id of chunk) {
      const store = storeById.get(id) ?? 'Unbekannt';
      out.staleByStore[store] = (out.staleByStore[store] ?? 0) + 1;
    }
  }
  return out;
}

export async function syncDealsToSupabase(
  offers: Offer[],
  offerScopes: OfferScopeMap,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const nextWeekOfferIds = options.nextWeekOfferIds ?? new Set<string>();
  const now = options.now ?? new Date();
  const startedAt = Date.now();
  const result: SyncResult = {
    attempted: offers.length,
    upserted: 0,
    skipped: 0,
    errors: [],
    durationMs: 0,
    staleExpired: 0,
    staleByStore: {},
    staleExpireErrors: [],
    collisions: 0,
    collisionSamples: [],
    currentBucketForcedTodayCount: 0,
    futureBucketForcedTomorrowCount: 0,
    disabledExpired: 0,
    disabledByStore: {},
    disabledExpireErrors: [],
  };

  const client = options.client ?? getClient();
  if (!client) {
    result.errors.push('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — sync skipped.');
    result.skipped = offers.length;
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // Build every row up front so we can dedupe on the table's unique key before
  // any upsert. Building all rows for one snapshot (~1.5k offers) is cheap.
  const built: DealRow[] = [];
  for (const offer of offers) {
    try {
      const bucket: OfferSyncBucket = nextWeekOfferIds.has(offer.id) ? 'next' : 'current';
      // Count the bucket-dominant overrides for diagnostics. Cheap pure call;
      // offerToDealRow resolves the same value internally for valid_from.
      const { forced } = resolveValidFrom(offer.validityStart, bucket, now);
      if (forced === 'current_forced_today') result.currentBucketForcedTodayCount += 1;
      else if (forced === 'next_forced_tomorrow') result.futureBucketForcedTomorrowCount += 1;
      built.push(
        offerToDealRow(offer as Offer & Record<string, unknown>, offerScopes, bucket, now),
      );
    } catch (e) {
      result.skipped += 1;
      result.errors.push(`offer ${offer.id}: ${(e as Error).message}`);
    }
  }

  const deduped = dedupeDealRows(built);
  result.collisions = deduped.collisions;
  result.collisionSamples = deduped.collisionSamples;
  const rows = deduped.rows;

  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await client
      .from('deals')
      .upsert(slice, { onConflict: 'source,source_external_id' });

    if (error) {
      result.errors.push(`batch ${i}-${i + slice.length}: ${error.message}`);
      result.skipped += slice.length;
    } else {
      result.upserted += slice.length;
    }
  }

  // Stale-cleanup: only meaningful when something was actually upserted (an
  // empty/failed sync must NEVER expire the live table).
  if (result.upserted > 0) {
    const cleanup = await expireStaleDeals(client, rows, now);
    result.staleExpired = cleanup.staleExpired;
    result.staleByStore = cleanup.staleByStore;
    result.staleExpireErrors = cleanup.errors;
  }

  // Disabled-store expire: collapse old ACTIVE deals of policy-disabled stores
  // (ALDI SÜD/NORD, Lidl) so Cheffity stops showing them. Runs independently of
  // the upsert volume — disabled stores are absent from the snapshot on purpose,
  // not because of a failed scrape — but only when a disabled set is configured.
  const disabledStores = options.disabledStores ?? [];
  if (disabledStores.length > 0) {
    const disabledCleanup = await expireDisabledStoreDeals(client, disabledStores, now);
    result.disabledExpired = disabledCleanup.staleExpired;
    result.disabledByStore = disabledCleanup.staleByStore;
    result.disabledExpireErrors = disabledCleanup.errors;
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
