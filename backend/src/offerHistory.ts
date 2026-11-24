// Offer-History v1 — append-mostly Verlauf der Angebote pro Snapshot.
//
// Architektur:
//   `public.deals` bleibt eine UPSERT-Tabelle ("aktueller Stand").
//   `public.offer_history` ist die Time-Series daneben — pro Snapshot eine
//   Zeile pro Angebot, append-only innerhalb desselben Snapshots.
//
// Datenfluss bei jedem Sync:
//   1. Backend ruft `syncDealsToSupabase()` → upsertet `deals`.
//   2. Direkt danach (siehe `server.ts`) ruft das Backend
//      `writeOfferHistory()` mit demselben Offers-Array auf.
//   3. `writeOfferHistory()` baut einen stabilen `snapshot_id` (Datum + Hash
//      der Offer-IDs), dedupliziert + upsertet idempotent in
//      `offer_history`. Ein erneuter Sync mit demselben Snapshot ändert
//      nur `last_seen_at` der bereits geschriebenen Zeilen.
//   4. Optional: Offers, die im Vorgänger-Snapshot vorhanden waren, jetzt
//      aber nicht mehr, bekommen `expired_at` gesetzt — passiert per
//      separater DB-UPDATE.
//
// Dieser File ist absichtlich klein gehalten:
//   - reine Helfer (canonicalProductKey, diffSnapshot, buildHistoryRow)
//     sind unit-getestet und kommen ohne Supabase aus.
//   - `writeOfferHistory()` ist der Supabase-IO-Teil, fail-soft (Fehler
//     werden in das Sync-Result gehängt, nicht geworfen).

import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Offer } from '../../src/types/models';
import { normalizeText } from '../../src/utils/offers';
import { deriveDealEnrichment } from './dealFields';
import {
  deriveDealSource,
  storeScopedExternalId,
  type DealSource,
} from './services/supabaseDealsSync';

// Cap auf die Raw-Payload-Größe, damit wir keine OCR-Volltexte oder
// 50 KB Connector-HTML in der DB landen. Reicht für ein paar Felder
// + Tags + die wichtigsten Diet-Flags.
const MAX_RAW_PAYLOAD_BYTES = 4096;

export interface HistoryRow {
  snapshot_id: string;
  observed_at: string;
  source: DealSource;
  source_external_id: string;
  canonical_product_key: string;
  barcode: string | null;
  store_name: string;
  product_name: string;
  brand: string | null;
  category: string | null;
  image_url: string | null;
  price: number;
  original_price: number | null;
  savings_percent: number | null;
  currency: string;
  valid_from: string | null;
  valid_until: string | null;
  is_national: boolean | null;
  raw_payload: unknown;
}

export interface WriteHistoryResult {
  attempted: number;
  written: number;
  expired: number;
  snapshotId: string;
  /** uuid of the offer_scan_runs row this sync was tracked under, or null
   *  if the table is not reachable (pre-push) or the run could not be
   *  created. History rows are written either way. */
  scanRunId: string | null;
  durationMs: number;
  errors: string[];
}

export type ScanType =
  | 'manual_sync'
  | 'one_click_ai'
  | 'auto_sync'
  | 'test'
  | 'unknown';

const KNOWN_SCAN_TYPES: ReadonlySet<ScanType> = new Set([
  'manual_sync',
  'one_click_ai',
  'auto_sync',
  'test',
  'unknown',
]);

/**
 * Coerce an arbitrary input to a ScanType, defaulting to 'unknown'. The
 * DB has a CHECK constraint with exactly the same values, so anything
 * else would reject the row — this guard keeps the INSERT cheap and
 * predictable for callers that pass user-controlled strings.
 */
export function normalizeScanType(value: unknown): ScanType {
  if (typeof value === 'string' && KNOWN_SCAN_TYPES.has(value as ScanType)) {
    return value as ScanType;
  }
  return 'unknown';
}

export type ScanStatus = 'started' | 'completed' | 'failed';

// --- Reine Helfer (unit-getestet) ---------------------------------------

/**
 * Build a cross-store matching key for a product. Strategy:
 *
 *   1. If a barcode (GTIN/EAN) is on the offer/payload → `barcode:<digits>`.
 *      Strongest match — same physical product across any store.
 *   2. Else if a brand exists → `name:<brand>+<name>` (both normalized).
 *      Reduces false matches between e.g. "REWE Bio Milch" and "Aldi Bio
 *      Milch" — same generic name, different brand.
 *   3. Else → `name:<name>` only.
 *
 * Deliberately STORE-AGNOSTIC: we want "Coca-Cola 1L" at REWE and at Lidl
 * to share a key so a favorite at REWE flips to "wieder bei Lidl im
 * Angebot" automatically.
 *
 * Conservative: never throws, always returns a non-empty key (falls back
 * to a hash of the offer id if everything else is missing).
 */
export function canonicalProductKey(
  offer: Pick<Offer, 'id' | 'name' | 'brand'> & { barcode?: unknown },
): string {
  const barcode = extractBarcode(offer);
  if (barcode) return `barcode:${barcode}`;

  const name = String(offer.name ?? '').trim();
  const brand = String(offer.brand ?? '').trim();

  if (name) {
    const normName = normalizeText(name);
    const cleanName = normName.replace(/\s+/g, ' ').trim();
    if (brand) {
      const normBrand = normalizeText(brand).replace(/\s+/g, ' ').trim();
      return `name:${normBrand}+${cleanName}`;
    }
    return `name:${cleanName}`;
  }

  // Last resort: hash the offer id so we don't collide with anything.
  return `id:${createHash('sha1').update(offer.id || 'unknown').digest('hex').slice(0, 12)}`;
}

/** Extract a barcode/GTIN-like string from an offer if any field carries one. */
export function extractBarcode(offer: { barcode?: unknown } & Record<string, unknown>): string | null {
  const candidates = [offer.barcode, offer.gtin, offer.ean];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      const digits = String(candidate).replace(/\D+/g, '');
      // GTIN-8 / 12 / 13 / 14. Anything outside that range is noise.
      if (digits.length >= 8 && digits.length <= 14) return digits;
    }
  }
  return null;
}

/**
 * Compute a deterministic snapshot id from the live offers in this sync run.
 * Stable hash over the sorted offer ids — re-running the same set produces
 * the same snapshot id, so the UNIQUE(snapshot_id, source, source_external_id)
 * constraint silently dedupes a re-run.
 *
 * The leading `YYYY-MM-DDTHH:mm:00Z` minute marker keeps snapshot ids
 * roughly grouped by hour in DB scans, even if the offer set is unchanged.
 */
export function computeSnapshotId(offers: Array<Pick<Offer, 'id'>>, now = new Date()): string {
  const ids = offers
    .map((o) => o.id || '')
    .filter(Boolean)
    .sort()
    .join('|');
  const hash = createHash('sha1').update(ids).digest('hex').slice(0, 10);
  const ts = now.toISOString().slice(0, 16) + ':00Z'; // minute resolution
  return `${ts}-${hash}`;
}

function trimSize(value: unknown, maxBytes: number): unknown {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (json.length <= maxBytes) return value;
  return { _truncated: true, _originalBytes: json.length };
}

/** Build a single history row from an Offer. Pure; no IO. */
export function buildHistoryRow(
  offer: Offer & Record<string, unknown>,
  snapshotId: string,
  now = new Date(),
): HistoryRow {
  const enrichment = deriveDealEnrichment(offer);
  const observedAt = now.toISOString();
  const validFromIso = String(offer.validityStart ?? '').slice(0, 10) || null;
  const validUntilIso = String(offer.validityEnd ?? '').slice(0, 10) || null;
  const barcode = extractBarcode(offer);
  const isNational = offer.sourceScope === 'national'
    ? true
    : offer.sourceScope === 'local'
      ? false
      : null;

  // Minimal raw_payload: just the fields that aren't already columns above.
  // Critically: NO `description` / NO raw OCR / NO connector html.
  const rawPayload = trimSize({
    tags: Array.isArray(offer.tags) ? offer.tags.slice(0, 20) : [],
    unit: offer.unit ?? null,
    basePrice: offer.basePrice ?? null,
    baseUnit: offer.baseUnit ?? null,
    postalCode: offer.postalCode ?? null,
    isHalal: enrichment.isHalal,
    containsAlcohol: enrichment.containsAlcohol,
    allergens: enrichment.allergens,
  }, MAX_RAW_PAYLOAD_BYTES);

  return {
    snapshot_id: snapshotId,
    observed_at: observedAt,
    source: deriveDealSource(offer),
    // Mirror the store-scoped key written to `deals` so offer_history stays
    // joinable 1:1 against the live table, and so REWE/nahkauf sharing a
    // connector id don't collide on the (snapshot_id, source, source_external_id)
    // unique constraint within one snapshot.
    source_external_id: storeScopedExternalId(offer),
    canonical_product_key: canonicalProductKey(offer),
    barcode,
    store_name: offer.storeChain || 'Unbekannt',
    product_name: offer.name || '(ohne Name)',
    brand: typeof offer.brand === 'string' && offer.brand.trim() ? offer.brand.trim() : null,
    category: offer.category || null,
    image_url: typeof offer.imageUrl === 'string' && offer.imageUrl.trim() ? offer.imageUrl : null,
    price: Number.isFinite(Number(offer.price)) ? Number(offer.price) : 0,
    original_price: enrichment.originalPrice,
    savings_percent: enrichment.savingsPercent,
    currency: offer.currency || 'EUR',
    valid_from: validFromIso,
    valid_until: validUntilIso,
    is_national: isNational,
    raw_payload: rawPayload,
  };
}

export interface DiffSummary {
  newOfferIds: string[];
  seenAgainOfferIds: string[];
  changedOfferIds: string[];
  expiredOfferIds: string[];
}

/**
 * Diff a current snapshot against the previous one.
 *
 * `previous` is a Map of `(source:external_id)` → previous HistoryRow (the
 * most-recent row per offer). The "changed" bucket fires when price OR
 * original_price OR valid_until differ — exactly the fields a user would
 * notice on the deal card.
 */
export function diffSnapshot(
  current: HistoryRow[],
  previous: Map<string, HistoryRow>,
): DiffSummary {
  const out: DiffSummary = {
    newOfferIds: [],
    seenAgainOfferIds: [],
    changedOfferIds: [],
    expiredOfferIds: [],
  };
  const currentKeys = new Set<string>();

  for (const row of current) {
    const key = `${row.source}:${row.source_external_id}`;
    currentKeys.add(key);
    const prev = previous.get(key);
    if (!prev) {
      out.newOfferIds.push(row.source_external_id);
      continue;
    }
    const priceChanged = Number(prev.price) !== Number(row.price);
    const origChanged = (prev.original_price ?? null) !== (row.original_price ?? null);
    const validChanged = (prev.valid_until ?? null) !== (row.valid_until ?? null);
    if (priceChanged || origChanged || validChanged) {
      out.changedOfferIds.push(row.source_external_id);
    } else {
      out.seenAgainOfferIds.push(row.source_external_id);
    }
  }

  for (const [key, row] of previous.entries()) {
    if (!currentKeys.has(key)) out.expiredOfferIds.push(row.source_external_id);
  }

  return out;
}

/**
 * Compute the retention cutoff timestamp for the offer-history table. Pure.
 * Default 12 Monate (siehe ADMIN_V2_RELEASE_CHECKLIST + bericht.md).
 */
export function historyRetentionCutoff(now = new Date(), months = 12): string {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff.toISOString();
}

// ─── ISO-8601 week helpers ───────────────────────────────────────────────
//
// Mirrors the semantics of the Postgres view `offer_history_weekly`:
//   - `iso_year`  = ISO 8601 year (week containing the first Thursday).
//   - `iso_week`  = ISO 8601 week (1..53).
//   - `week_start_date` = Monday of the week, in UTC (YYYY-MM-DD).
//
// Always UTC-aligned because the DB stores `observed_at` as `timestamptz`
// (effectively UTC). Doing the computation in local time would drift on
// year boundaries depending on the user's timezone, which is exactly what
// we don't want when matching against the view.

export interface IsoWeekKey {
  isoYear: number;
  isoWeek: number;
  /** Monday of the ISO week, YYYY-MM-DD (UTC). */
  weekStartDate: string;
}

/**
 * Compute the ISO 8601 week key for a timestamp.
 * Accepts a Date, a number (epoch ms) or a parseable ISO string. Throws on
 * invalid input — silently producing wrong week numbers would be worse.
 */
export function isoWeekKey(input: Date | number | string): IsoWeekKey {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`isoWeekKey: invalid date input ${String(input)}`);
  }
  // Work on a UTC-anchored copy that represents the calendar day only.
  const day = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  // ISO weeks run Mon..Sun. Shift to the Thursday of the current week —
  // that's the day that decides which ISO year the week belongs to.
  const dayNumber = (day.getUTCDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  const thursday = new Date(day);
  thursday.setUTCDate(day.getUTCDate() - dayNumber + 3);
  const isoYear = thursday.getUTCFullYear();
  // First Thursday of that ISO year.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const firstThursday = new Date(jan4);
  firstThursday.setUTCDate(jan4.getUTCDate() - jan4Day + 3);
  const isoWeek = 1 + Math.round(
    (thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000),
  );
  // Monday of the original calendar day.
  const monday = new Date(day);
  monday.setUTCDate(day.getUTCDate() - dayNumber);
  return {
    isoYear,
    isoWeek,
    weekStartDate: monday.toISOString().slice(0, 10),
  };
}

// ─── Snapshot-count aggregation ──────────────────────────────────────────
//
// The base table can hold multiple rows per (canonical_product_key,
// store_name) inside ONE snapshot when two offers normalize to the same
// canonical key (different package sizes, brand spellings, etc.). The
// "wiederholt beobachtet"-stat must count distinct snapshots, not raw rows.

interface SnapshotCountable {
  snapshot_id: string;
  canonical_product_key: string;
  store_name: string;
}

export interface SnapshotCountByKey {
  canonical_product_key: string;
  store_name: string;
  snapshotCount: number;
  rowCount: number;
}

/**
 * Aggregate a flat list of observations into one entry per
 * `(canonical_product_key, store_name)` carrying both `snapshotCount`
 * (= count of distinct snapshot_id, the user-facing "seen-again" stat)
 * and `rowCount` (= raw row count, for debug).
 *
 * Pure — used both as the in-JS fallback when the DB view isn't reachable
 * and as the explicit contract the unit tests pin down.
 */
export function countSnapshotsPerProduct(
  rows: SnapshotCountable[],
): SnapshotCountByKey[] {
  // Two maps: one of seen snapshot ids per group, one of raw row counts.
  const snapshotsPerGroup = new Map<string, Set<string>>();
  const rowsPerGroup = new Map<string, number>();
  // Stable iteration order for predictable test output: insertion order.
  const groupMeta = new Map<string, { canonical: string; store: string }>();

  for (const row of rows) {
    if (!row.canonical_product_key || !row.store_name || !row.snapshot_id) continue;
    const key = `${row.canonical_product_key}${row.store_name}`;
    if (!groupMeta.has(key)) {
      groupMeta.set(key, {
        canonical: row.canonical_product_key,
        store: row.store_name,
      });
    }
    let set = snapshotsPerGroup.get(key);
    if (!set) {
      set = new Set();
      snapshotsPerGroup.set(key, set);
    }
    set.add(row.snapshot_id);
    rowsPerGroup.set(key, (rowsPerGroup.get(key) ?? 0) + 1);
  }

  const out: SnapshotCountByKey[] = [];
  for (const [key, meta] of groupMeta.entries()) {
    out.push({
      canonical_product_key: meta.canonical,
      store_name: meta.store,
      snapshotCount: snapshotsPerGroup.get(key)?.size ?? 0,
      rowCount: rowsPerGroup.get(key) ?? 0,
    });
  }
  // Sort: most repeated first; ties broken by row count, then by canonical key
  // for stability.
  out.sort((a, b) => {
    if (b.snapshotCount !== a.snapshotCount) return b.snapshotCount - a.snapshotCount;
    if (b.rowCount !== a.rowCount) return b.rowCount - a.rowCount;
    return a.canonical_product_key.localeCompare(b.canonical_product_key);
  });
  return out;
}

// ─── ISO-week → date range (inverse of isoWeekKey) ───────────────────────
//
// The calendar explorer needs to turn a clicked `(isoYear, isoWeek)` back
// into the Monday..Sunday span so we can range-query `offer_history` by
// `observed_at`. This is the exact inverse of `isoWeekKey` and uses the
// same UTC-anchored ISO-8601 rules (Jan 4 is always in week 1).

export interface IsoWeekRange {
  isoYear: number;
  isoWeek: number;
  /** Monday of the ISO week, YYYY-MM-DD (UTC). */
  weekStartDate: string;
  /** Sunday of the ISO week, YYYY-MM-DD (UTC). */
  weekEndDate: string;
  /** Monday 00:00:00.000Z — inclusive lower bound for observed_at queries. */
  startIso: string;
  /** Next Monday 00:00:00.000Z — EXCLUSIVE upper bound (so Sunday 23:59:59
   *  is included without date-rounding bugs). */
  endExclusiveIso: string;
}

export function isoWeekToDateRange(isoYear: number, isoWeek: number): IsoWeekRange {
  if (
    !Number.isInteger(isoYear) ||
    !Number.isInteger(isoWeek) ||
    isoWeek < 1 ||
    isoWeek > 53
  ) {
    throw new Error(`isoWeekToDateRange: invalid year/week ${String(isoYear)}/${String(isoWeek)}`);
  }
  // Jan 4th is — by ISO-8601 definition — always in week 1 of its year.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  // Monday of ISO week 1.
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow);
  // Monday of the requested week.
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (isoWeek - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const nextMonday = new Date(monday);
  nextMonday.setUTCDate(monday.getUTCDate() + 7);
  return {
    isoYear,
    isoWeek,
    weekStartDate: monday.toISOString().slice(0, 10),
    weekEndDate: sunday.toISOString().slice(0, 10),
    startIso: monday.toISOString(),
    endExclusiveIso: nextMonday.toISOString(),
  };
}

// ─── Small numeric/string coercers (pure) ────────────────────────────────

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length ? t : null;
}

// ─── Per-week overview aggregation (pure) ────────────────────────────────
//
// Reduces a flat list of history observations into one summary per ISO
// week. Used by the calendar explorer's week list. Multiple scans (snapshots)
// in the same week are counted distinctly; the same offer observed across
// several snapshots collapses to one offer.

interface WeekCountableRow {
  observed_at?: unknown;
  snapshot_id?: unknown;
  store_name?: unknown;
  source?: unknown;
  source_external_id?: unknown;
}

export interface HistoryWeekSummary {
  isoYear: number;
  isoWeek: number;
  weekStartDate: string;
  weekEndDate: string;
  /** Distinct snapshot_id values observed in the week. */
  snapshotCount: number;
  /** Distinct (source, source_external_id) offers observed in the week. */
  offerCount: number;
  /** Distinct store_name values observed in the week. */
  storeCount: number;
  /** Latest observed_at in the week (ISO string) or null. */
  latestObservedAt: string | null;
}

export function aggregateHistoryWeeks(rows: WeekCountableRow[]): HistoryWeekSummary[] {
  interface Acc {
    isoYear: number;
    isoWeek: number;
    snapshots: Set<string>;
    offers: Set<string>;
    stores: Set<string>;
    latest: string | null;
  }
  const groups = new Map<string, Acc>();
  for (const row of rows) {
    const observedAt = typeof row.observed_at === 'string' ? row.observed_at : '';
    if (!observedAt) continue;
    let key: IsoWeekKey;
    try {
      key = isoWeekKey(observedAt);
    } catch {
      continue; // unparseable timestamp → skip rather than mis-bucket
    }
    const gk = `${key.isoYear}-${key.isoWeek}`;
    let g = groups.get(gk);
    if (!g) {
      g = {
        isoYear: key.isoYear,
        isoWeek: key.isoWeek,
        snapshots: new Set(),
        offers: new Set(),
        stores: new Set(),
        latest: null,
      };
      groups.set(gk, g);
    }
    const snapshotId = trimToNull(row.snapshot_id);
    if (snapshotId) g.snapshots.add(snapshotId);
    const storeName = trimToNull(row.store_name);
    if (storeName) g.stores.add(storeName);
    const externalId = trimToNull(row.source_external_id);
    if (externalId) g.offers.add(`${trimToNull(row.source) ?? ''}:${externalId}`);
    if (!g.latest || observedAt > g.latest) g.latest = observedAt;
  }
  const out: HistoryWeekSummary[] = [];
  for (const g of groups.values()) {
    const range = isoWeekToDateRange(g.isoYear, g.isoWeek);
    out.push({
      isoYear: g.isoYear,
      isoWeek: g.isoWeek,
      weekStartDate: range.weekStartDate,
      weekEndDate: range.weekEndDate,
      snapshotCount: g.snapshots.size,
      offerCount: g.offers.size,
      storeCount: g.stores.size,
      latestObservedAt: g.latest,
    });
  }
  // Newest week first (string compare on YYYY-MM-DD is chronological).
  out.sort((a, b) =>
    a.weekStartDate < b.weekStartDate ? 1 : a.weekStartDate > b.weekStartDate ? -1 : 0,
  );
  return out;
}

// ─── Per-week detail aggregation (pure) ──────────────────────────────────
//
// Groups raw observations of a single week into one row per
// (canonical_product_key, store_name). Computes min/avg/max price across all
// observations in the week, distinct-snapshot count, raw row count, the
// observation window and the furthest validity. Display fields (name, brand,
// category, image, original price, savings) are taken from the most-recent
// observation in the group so the table shows the latest known state.

interface WeekOfferRow {
  snapshot_id?: unknown;
  observed_at?: unknown;
  canonical_product_key?: unknown;
  store_name?: unknown;
  product_name?: unknown;
  brand?: unknown;
  category?: unknown;
  image_url?: unknown;
  price?: unknown;
  original_price?: unknown;
  savings_percent?: unknown;
  valid_until?: unknown;
}

export interface WeekOfferGroup {
  canonicalProductKey: string;
  name: string;
  brand: string | null;
  store: string;
  category: string | null;
  imageUrl: string | null;
  minPrice: number;
  avgPrice: number;
  maxPrice: number;
  originalPrice: number | null;
  savingsPercent: number | null;
  snapshotCount: number;
  rowCount: number;
  firstObserved: string;
  lastObserved: string;
  validUntil: string | null;
  /** True when more than one distinct price was observed across the week. */
  priceChanged: boolean;
}

export function aggregateWeekOffers(rows: WeekOfferRow[]): WeekOfferGroup[] {
  interface Acc {
    canonical: string;
    store: string;
    name: string;
    brand: string | null;
    category: string | null;
    imageUrl: string | null;
    snapshots: Set<string>;
    rowCount: number;
    priceSum: number;
    priceCount: number;
    minPrice: number;
    maxPrice: number;
    originalPrice: number | null;
    savingsPercent: number | null;
    validUntil: string | null;
    firstObserved: string;
    lastObserved: string;
    latestStamp: string;
    distinctPrices: Set<number>;
  }
  const groups = new Map<string, Acc>();
  for (const row of rows) {
    const canonical = trimToNull(row.canonical_product_key);
    const store = trimToNull(row.store_name);
    if (!canonical || !store) continue;
    const key = `${canonical} ${store}`;
    const observed = typeof row.observed_at === 'string' ? row.observed_at : '';
    let g = groups.get(key);
    if (!g) {
      g = {
        canonical,
        store,
        name: '',
        brand: null,
        category: null,
        imageUrl: null,
        snapshots: new Set(),
        rowCount: 0,
        priceSum: 0,
        priceCount: 0,
        minPrice: Infinity,
        maxPrice: -Infinity,
        originalPrice: null,
        savingsPercent: null,
        validUntil: null,
        firstObserved: observed,
        lastObserved: observed,
        latestStamp: '',
        distinctPrices: new Set(),
      };
      groups.set(key, g);
    }
    g.rowCount += 1;
    const snapshotId = trimToNull(row.snapshot_id);
    if (snapshotId) g.snapshots.add(snapshotId);
    const price = toFiniteNumber(row.price);
    if (price !== null) {
      g.priceSum += price;
      g.priceCount += 1;
      if (price < g.minPrice) g.minPrice = price;
      if (price > g.maxPrice) g.maxPrice = price;
      g.distinctPrices.add(Math.round(price * 100));
    }
    if (observed) {
      if (!g.firstObserved || observed < g.firstObserved) g.firstObserved = observed;
      if (!g.lastObserved || observed > g.lastObserved) g.lastObserved = observed;
    }
    // Display fields from the most-recent observation in the group.
    if (observed >= g.latestStamp) {
      g.latestStamp = observed;
      const nm = trimToNull(row.product_name);
      if (nm) g.name = nm;
      g.brand = trimToNull(row.brand) ?? g.brand;
      g.category = trimToNull(row.category) ?? g.category;
      const img = trimToNull(row.image_url);
      if (img) g.imageUrl = img;
      const op = toFiniteNumber(row.original_price);
      if (op !== null) g.originalPrice = op;
      const sp = toFiniteNumber(row.savings_percent);
      if (sp !== null) g.savingsPercent = sp;
    }
    // valid_until: keep the furthest-out date so the table shows the longest
    // remaining validity for the product in that week.
    const vu = trimToNull(row.valid_until);
    if (vu && (!g.validUntil || vu > g.validUntil)) g.validUntil = vu;
  }
  const out: WeekOfferGroup[] = [];
  for (const g of groups.values()) {
    const hasPrice = g.priceCount > 0;
    out.push({
      canonicalProductKey: g.canonical,
      name: g.name || '(ohne Name)',
      brand: g.brand,
      store: g.store,
      category: g.category,
      imageUrl: g.imageUrl,
      minPrice: hasPrice ? round2(g.minPrice) : 0,
      avgPrice: hasPrice ? round2(g.priceSum / g.priceCount) : 0,
      maxPrice: hasPrice ? round2(g.maxPrice) : 0,
      originalPrice: g.originalPrice,
      savingsPercent: g.savingsPercent,
      snapshotCount: g.snapshots.size,
      rowCount: g.rowCount,
      firstObserved: g.firstObserved,
      lastObserved: g.lastObserved,
      validUntil: g.validUntil,
      priceChanged: g.distinctPrices.size > 1,
    });
  }
  // Most repeated first; ties by raw rows, then by name for stability.
  out.sort((a, b) => {
    if (b.snapshotCount !== a.snapshotCount) return b.snapshotCount - a.snapshotCount;
    if (b.rowCount !== a.rowCount) return b.rowCount - a.rowCount;
    return a.name.localeCompare(b.name);
  });
  return out;
}

// --- Supabase-IO --------------------------------------------------------

let cachedClient: SupabaseClient | null | undefined;

function getClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    cachedClient = null;
    return null;
  }
  cachedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedClient;
}

// ─── Scan-run lifecycle ──────────────────────────────────────────────────
//
// One scan-run = one sync attempt = one snapshot_id. The DB enforces
// uniqueness on snapshot_id, so re-entrant writeOfferHistory calls reuse
// the same run instead of creating duplicates. Lifecycle:
//
//   start  → row inserted with status='started'
//   complete → status='completed', counters + completed_at set
//   fail   → status='failed', error_message + completed_at set
//
// All three are fail-soft: any errors append to the caller's result; the
// history-write itself is never blocked by a run failure.

export interface StartScanRunInput {
  snapshotId: string;
  scanType: ScanType;
  offersCount: number;
  now?: Date;
}

/**
 * Insert (or fetch the existing) scan-run row for `snapshotId`. Returns
 * the row's uuid so subsequent history-row inserts can carry it. If the
 * table is not reachable (pre-push, mis-configured Supabase) returns null
 * and the caller proceeds without scan_run_id — history rows are still
 * written.
 */
export async function startOfferScanRun(
  input: StartScanRunInput,
): Promise<{ id: string; isExisting: boolean } | null> {
  const client = getClient();
  if (!client) return null;
  const now = input.now ?? new Date();
  const week = isoWeekKey(now);
  const weekEnd = (() => {
    const d = new Date(`${week.weekStartDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().slice(0, 10);
  })();
  const row = {
    snapshot_id: input.snapshotId,
    scan_type: normalizeScanType(input.scanType),
    status: 'started' as ScanStatus,
    iso_year: week.isoYear,
    iso_week: week.isoWeek,
    week_start_date: week.weekStartDate,
    week_end_date: weekEnd,
    started_at: now.toISOString(),
    offers_count: Math.max(0, input.offersCount | 0),
  };
  // INSERT … ON CONFLICT DO NOTHING via supabase-js: upsert with
  // ignoreDuplicates=true keeps the existing row untouched. Then SELECT
  // by snapshot_id to learn the uuid + whether we just created it.
  const { data, error } = await client
    .from('offer_scan_runs')
    .upsert(row, { onConflict: 'snapshot_id', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();
  if (error) return null;
  if (data && (data as { id?: string }).id) {
    return { id: (data as { id: string }).id, isExisting: false };
  }
  // ignoreDuplicates path: row already existed, fetch its id explicitly.
  const { data: existing, error: lookupError } = await client
    .from('offer_scan_runs')
    .select('id')
    .eq('snapshot_id', input.snapshotId)
    .maybeSingle();
  if (lookupError || !existing) return null;
  return { id: (existing as { id: string }).id, isExisting: true };
}

export interface CompleteScanRunInput {
  snapshotId: string;
  historyWrittenCount: number;
  expiredCount: number;
  errorCount: number;
  now?: Date;
}

export async function completeOfferScanRun(
  input: CompleteScanRunInput,
): Promise<void> {
  const client = getClient();
  if (!client) return;
  const now = input.now ?? new Date();
  await client
    .from('offer_scan_runs')
    .update({
      status: 'completed',
      completed_at: now.toISOString(),
      history_written_count: Math.max(0, input.historyWrittenCount | 0),
      expired_count: Math.max(0, input.expiredCount | 0),
      error_count: Math.max(0, input.errorCount | 0),
    })
    .eq('snapshot_id', input.snapshotId);
}

export interface FailScanRunInput {
  snapshotId: string;
  errorMessage: string;
  now?: Date;
}

export async function failOfferScanRun(
  input: FailScanRunInput,
): Promise<void> {
  const client = getClient();
  if (!client) return;
  const now = input.now ?? new Date();
  await client
    .from('offer_scan_runs')
    .update({
      status: 'failed',
      completed_at: now.toISOString(),
      error_message: input.errorMessage.slice(0, 4000),
    })
    .eq('snapshot_id', input.snapshotId);
}

export interface OfferScanRunSummary {
  id: string;
  snapshotId: string;
  scanType: ScanType;
  status: ScanStatus;
  isoYear: number;
  isoWeek: number;
  weekStartDate: string;
  weekEndDate: string;
  startedAt: string;
  completedAt: string | null;
  offersCount: number;
  historyWrittenCount: number;
  expiredCount: number;
  errorCount: number;
  errorMessage: string | null;
}

/**
 * Map a raw `offer_scan_runs` row into the camel-cased API shape.
 * Pure — unit-testable. Unknown scan_type/status values are coerced to
 * 'unknown'/'failed' rather than passing junk through.
 */
export function normalizeOfferScanRunRow(
  row: Record<string, unknown>,
): OfferScanRunSummary | null {
  const id = String(row.id ?? '');
  const snapshotId = String(row.snapshot_id ?? '');
  if (!id || !snapshotId) return null;
  const statusRaw = String(row.status ?? '');
  const status: ScanStatus =
    statusRaw === 'started' || statusRaw === 'completed' || statusRaw === 'failed'
      ? statusRaw
      : 'failed';
  return {
    id,
    snapshotId,
    scanType: normalizeScanType(row.scan_type),
    status,
    isoYear: Number(row.iso_year ?? 0),
    isoWeek: Number(row.iso_week ?? 0),
    weekStartDate: String(row.week_start_date ?? ''),
    weekEndDate: String(row.week_end_date ?? ''),
    startedAt: String(row.started_at ?? ''),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    offersCount: Number(row.offers_count ?? 0),
    historyWrittenCount: Number(row.history_written_count ?? 0),
    expiredCount: Number(row.expired_count ?? 0),
    errorCount: Number(row.error_count ?? 0),
    errorMessage: row.error_message ? String(row.error_message) : null,
  };
}

export interface OfferScanRunsResult {
  available: boolean;
  generatedAt: string;
  runs: OfferScanRunSummary[];
  error: string | null;
}

export async function getOfferScanRuns(limit = 50): Promise<OfferScanRunsResult> {
  const generatedAt = new Date().toISOString();
  const client = getClient();
  if (!client) {
    return {
      available: false,
      generatedAt,
      runs: [],
      error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nicht gesetzt.',
    };
  }
  const safeLimit = Math.min(Math.max(1, limit | 0), 200);
  const { data, error } = await client
    .from('offer_scan_runs')
    .select(
      'id, snapshot_id, scan_type, status, iso_year, iso_week, week_start_date, week_end_date, started_at, completed_at, offers_count, history_written_count, expired_count, error_count, error_message',
    )
    .order('started_at', { ascending: false })
    .limit(safeLimit);
  if (error) {
    return { available: false, generatedAt, runs: [], error: error.message };
  }
  const runs = (data ?? [])
    .map((row) => normalizeOfferScanRunRow(row as Record<string, unknown>))
    .filter((r): r is OfferScanRunSummary => r !== null);
  return { available: true, generatedAt, runs, error: null };
}

/**
 * Append a snapshot of the current offers to `public.offer_history`.
 *
 * Idempotent: the UNIQUE constraint on (snapshot_id, source,
 * source_external_id) protects us against double-writing the same row in a
 * single sync, and `onConflict` updates `last_seen_at` so re-runs of the
 * same snapshot stay observable.
 *
 * Scan-run tracking: a row in `offer_scan_runs` is created (or reused)
 * for this snapshot before the history rows are upserted, so every row
 * carries the right `scan_run_id`. On completion the counters are
 * flushed back to the run; the snapshot's calendar week is anchored at
 * `started_at` (UTC).
 *
 * Fail-soft: returns errors in the result; never throws. Caller decides
 * whether to surface in dashboard warnings.
 */
export async function writeOfferHistory(
  offers: Array<Offer & Record<string, unknown>>,
  options: { scanType?: ScanType; now?: Date } = {},
): Promise<WriteHistoryResult> {
  const now = options.now ?? new Date();
  const scanType = normalizeScanType(options.scanType);
  const startedAt = Date.now();
  const snapshotId = computeSnapshotId(offers, now);
  const result: WriteHistoryResult = {
    attempted: offers.length,
    written: 0,
    expired: 0,
    snapshotId,
    scanRunId: null,
    durationMs: 0,
    errors: [],
  };

  const client = getClient();
  if (!client) {
    result.errors.push('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — offer-history sync skipped.');
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // Start the scan-run BEFORE the history rows so each row can carry the
  // FK back. If the run can't be created (pre-push table, transient
  // error), we proceed without the FK — history rows are still useful
  // standalone, the dashboard just won't surface the run.
  const runStart = await startOfferScanRun({
    snapshotId,
    scanType,
    offersCount: offers.length,
    now,
  });
  if (runStart) result.scanRunId = runStart.id;

  const seen = new Set<string>();
  const rows: Array<HistoryRow & { scan_run_id?: string | null }> = [];
  for (const offer of offers) {
    if (!offer.id || seen.has(offer.id)) continue;
    seen.add(offer.id);
    try {
      const row = buildHistoryRow(offer, snapshotId, now) as HistoryRow & {
        scan_run_id?: string | null;
      };
      if (result.scanRunId) row.scan_run_id = result.scanRunId;
      rows.push(row);
    } catch (e) {
      result.errors.push(`offer ${offer.id}: ${(e as Error).message}`);
    }
  }

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await client
      .from('offer_history')
      .upsert(slice, {
        onConflict: 'snapshot_id,source,source_external_id',
        ignoreDuplicates: false,
      });
    if (error) {
      result.errors.push(`batch ${i}-${i + slice.length}: ${error.message}`);
    } else {
      result.written += slice.length;
    }
  }

  // Mark offers that were seen in the previous snapshot but NOT in this one
  // as expired. We look at distinct ids per source from the previous run by
  // picking the most-recent observed_at per (source, external_id). Doing
  // this in SQL keeps the round-trip cheap.
  try {
    const currentExternalIds = new Set(rows.map((r) => `${r.source}:${r.source_external_id}`));
    // Pull the last 1000 most-recent NOT-expired rows that DON'T belong to
    // this snapshot. If they're missing from the new snapshot, expire.
    const { data, error } = await client
      .from('offer_history')
      .select('id, source, source_external_id, snapshot_id')
      .is('expired_at', null)
      .neq('snapshot_id', snapshotId)
      .order('observed_at', { ascending: false })
      .limit(2000);
    if (error) {
      result.errors.push(`expire-scan: ${error.message}`);
    } else if (Array.isArray(data)) {
      const toExpire: string[] = [];
      const seenExternal = new Set<string>();
      for (const row of data as Array<{ id: string; source: string; source_external_id: string }>) {
        const key = `${row.source}:${row.source_external_id}`;
        if (seenExternal.has(key)) continue;
        seenExternal.add(key);
        if (!currentExternalIds.has(key)) toExpire.push(row.id);
      }
      if (toExpire.length > 0) {
        // Chunk the id list: a single `.in('id', [...])` with up to 2000 ids
        // builds a query string long enough that PostgREST rejects it with a
        // 400 ("Bad Request") — the root cause of the historical
        // `expire-update: Bad Request`. Updating in small id batches keeps
        // every request well under the URL-length limit.
        const EXPIRE_CHUNK = 100;
        let expired = 0;
        for (let i = 0; i < toExpire.length; i += EXPIRE_CHUNK) {
          const chunk = toExpire.slice(i, i + EXPIRE_CHUNK);
          const { error: updErr, count } = await client
            .from('offer_history')
            .update({ expired_at: now.toISOString() }, { count: 'exact' })
            .in('id', chunk);
          if (updErr) result.errors.push(`expire-update ${i}-${i + chunk.length}: ${updErr.message}`);
          else expired += typeof count === 'number' ? count : chunk.length;
        }
        result.expired = expired;
      }
    }
  } catch (e) {
    result.errors.push(`expire: ${(e as Error).message}`);
  }

  // Flush counters back to the scan-run so the dashboard can render them
  // without joining offer_history. Always marks the run as 'completed' —
  // even when result.errors is non-empty, the run finished (just with
  // some batches failing). The full failure path (failOfferScanRun) is
  // reserved for callers that catch a top-level exception around
  // writeOfferHistory and want to mark the run as broken end-to-end.
  if (result.scanRunId) {
    await completeOfferScanRun({
      snapshotId,
      historyWrittenCount: result.written,
      expiredCount: result.expired,
      errorCount: result.errors.length,
      now: new Date(),
    }).catch((e) => {
      // Bookkeeping failure is non-fatal for the sync itself.
      result.errors.push(`scan-run complete: ${(e as Error).message}`);
    });
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

export interface HistoryStats {
  available: boolean;
  generatedAt: string;
  error: string | null;
  totalRows: number | null;
  oldestObservedAt: string | null;
  newestObservedAt: string | null;
  activeCanonicalKeys: number | null;
  topRepeatedProducts: Array<{
    canonicalProductKey: string;
    sampleName: string;
    storeName: string;
    /** Number of distinct snapshots — semantics changed in
     *  20260528000002. Old clients still read the same field name. */
    observationCount: number;
    /** Raw row count for the same group; surfaces in-snapshot duplicates. */
    rowCount: number;
    minPrice: number;
    maxPrice: number;
    firstObserved: string;
    lastObserved: string;
  }>;
  /** False when `offer_history_weekly` is not yet remote (pre-push). */
  weeklyAvailable: boolean;
  weeklyTopProducts: Array<{
    canonicalProductKey: string;
    sampleName: string;
    storeName: string;
    isoYear: number;
    isoWeek: number;
    weekStartDate: string;
    snapshotCount: number;
    minPrice: number;
    maxPrice: number;
    avgPrice: number;
  }>;
  recentlyReappearedCount: number | null;
  /** True only when offer_scan_runs is reachable (post-push). */
  scanRunsAvailable: boolean;
  latestRun: OfferScanRunSummary | null;
  /** How many scan-runs exist in the ISO week of `now` (= the calendar
   *  week of the most recently observed sync). 0 when the table is empty
   *  or unreachable. */
  currentWeekRunCount: number;
}

/**
 * Read-only history overview for /admin-v2.
 * Cached implicitly via the same Map cache pattern as `adminAggregator`.
 */
export async function getHistoryStats(): Promise<HistoryStats> {
  const stamp = new Date().toISOString();
  const client = getClient();
  if (!client) {
    return {
      available: false,
      generatedAt: stamp,
      error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nicht gesetzt.',
      totalRows: null,
      oldestObservedAt: null,
      newestObservedAt: null,
      activeCanonicalKeys: null,
      topRepeatedProducts: [],
      weeklyAvailable: false,
      weeklyTopProducts: [],
      recentlyReappearedCount: null,
      scanRunsAvailable: false,
      latestRun: null,
      currentWeekRunCount: 0,
    };
  }

  try {
    const [totalRes, oldestRes, newestRes, recentRes, activeRes, weeklyRes, latestRunRes] = await Promise.all([
      client.from('offer_history').select('*', { count: 'exact', head: true }),
      client.from('offer_history').select('observed_at').order('observed_at', { ascending: true }).limit(1),
      client.from('offer_history').select('observed_at').order('observed_at', { ascending: false }).limit(1),
      client
        .from('offer_history_recent')
        .select('canonical_product_key, store_name, sample_name, sample_brand, observation_count, row_count, min_price, max_price, first_observed, last_observed, has_active')
        .gt('observation_count', 1)
        .order('observation_count', { ascending: false })
        .limit(20),
      client.from('offer_history').select('canonical_product_key', { count: 'exact', head: true }).is('expired_at', null),
      // Weekly view may not exist yet (pre-push). Errors are surfaced as
      // `weeklyAvailable: false`, no PostgrestError thrown to the caller.
      client
        .from('offer_history_weekly')
        .select('canonical_product_key, store_name, sample_name, iso_year, iso_week, week_start_date, snapshot_count, min_price, max_price, avg_price')
        .order('snapshot_count', { ascending: false })
        .order('week_start_date', { ascending: false })
        .limit(20),
      // Most-recent scan-run for the dashboard's "letzter Sync"-card +
      // the `currentWeekRunCount` companion (counted from the same week).
      // Missing table → scanRunsAvailable becomes false.
      client
        .from('offer_scan_runs')
        .select(
          'id, snapshot_id, scan_type, status, iso_year, iso_week, week_start_date, week_end_date, started_at, completed_at, offers_count, history_written_count, expired_count, error_count, error_message',
        )
        .order('started_at', { ascending: false })
        .limit(1),
    ]);

    const topRepeatedProducts = (recentRes.data ?? [])
      .map((row) => row as Record<string, unknown>)
      .map((row) => ({
        canonicalProductKey: String(row.canonical_product_key ?? ''),
        sampleName: String(row.sample_name ?? ''),
        storeName: String(row.store_name ?? ''),
        observationCount: Number(row.observation_count ?? 0),
        rowCount: Number(row.row_count ?? row.observation_count ?? 0),
        minPrice: Number(row.min_price ?? 0),
        maxPrice: Number(row.max_price ?? 0),
        firstObserved: String(row.first_observed ?? ''),
        lastObserved: String(row.last_observed ?? ''),
      }));

    const weeklyAvailable = !weeklyRes.error;
    const weeklyTopProducts = weeklyAvailable
      ? (weeklyRes.data ?? [])
          .map((row) => row as Record<string, unknown>)
          .map((row) => ({
            canonicalProductKey: String(row.canonical_product_key ?? ''),
            sampleName: String(row.sample_name ?? ''),
            storeName: String(row.store_name ?? ''),
            isoYear: Number(row.iso_year ?? 0),
            isoWeek: Number(row.iso_week ?? 0),
            weekStartDate: String(row.week_start_date ?? ''),
            snapshotCount: Number(row.snapshot_count ?? 0),
            minPrice: Number(row.min_price ?? 0),
            maxPrice: Number(row.max_price ?? 0),
            avgPrice: Number(row.avg_price ?? 0),
          }))
      : [];

    const scanRunsAvailable = !latestRunRes.error;
    const latestRunRow = scanRunsAvailable ? (latestRunRes.data ?? [])[0] : null;
    const latestRun = latestRunRow
      ? normalizeOfferScanRunRow(latestRunRow as Record<string, unknown>)
      : null;

    // currentWeekRunCount: count scan-runs in the ISO week of the latest
    // run (or "now" if there's no run yet). Issued only when the table
    // is reachable. Uses a HEAD count to avoid a second SELECT payload.
    let currentWeekRunCount = 0;
    if (scanRunsAvailable) {
      const referenceDate =
        latestRun?.startedAt && latestRun.startedAt.length > 0
          ? new Date(latestRun.startedAt)
          : new Date();
      const week = isoWeekKey(referenceDate);
      const { count, error: countError } = await client
        .from('offer_scan_runs')
        .select('id', { count: 'exact', head: true })
        .eq('iso_year', week.isoYear)
        .eq('iso_week', week.isoWeek);
      if (!countError && typeof count === 'number') {
        currentWeekRunCount = count;
      }
    }

    return {
      available: true,
      generatedAt: stamp,
      error: totalRes.error?.message ?? null,
      totalRows: typeof totalRes.count === 'number' ? totalRes.count : null,
      oldestObservedAt: oldestRes.data?.[0]?.observed_at ?? null,
      newestObservedAt: newestRes.data?.[0]?.observed_at ?? null,
      activeCanonicalKeys: typeof activeRes.count === 'number' ? activeRes.count : null,
      topRepeatedProducts,
      weeklyAvailable,
      weeklyTopProducts,
      recentlyReappearedCount: null,
      scanRunsAvailable,
      latestRun,
      currentWeekRunCount,
    };
  } catch (e) {
    return {
      available: true,
      generatedAt: stamp,
      error: (e as Error).message,
      totalRows: null,
      oldestObservedAt: null,
      newestObservedAt: null,
      activeCanonicalKeys: null,
      topRepeatedProducts: [],
      weeklyAvailable: false,
      weeklyTopProducts: [],
      recentlyReappearedCount: null,
      scanRunsAvailable: false,
      latestRun: null,
      currentWeekRunCount: 0,
    };
  }
}

// ─── Calendar-week explorer (overview + detail) ──────────────────────────
//
// Supabase/PostgREST caps a single request at 1000 rows by default. A naive
// `.select()` would therefore SILENTLY return only the first 1000 history
// rows, undercounting weeks and products. `readOfferHistoryPaged` walks the
// table with `.range()` until a short page signals the end, so the
// aggregates are computed over the full set (up to a hard safety cap).

interface PagedReadOptions {
  select: string;
  gte?: { column: string; value: string };
  lt?: { column: string; value: string };
  order?: string;
  pageSize?: number;
  maxRows?: number;
}

interface PagedReadResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
  error: string | null;
}

async function readOfferHistoryPaged(
  client: SupabaseClient,
  options: PagedReadOptions,
): Promise<PagedReadResult> {
  const pageSize = Math.min(Math.max(1, options.pageSize ?? 1000), 1000);
  const maxRows = options.maxRows ?? 100000;
  const orderColumn = options.order ?? 'observed_at';
  const rows: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    let query = client.from('offer_history').select(options.select);
    if (options.gte) query = query.gte(options.gte.column, options.gte.value);
    if (options.lt) query = query.lt(options.lt.column, options.lt.value);
    const { data, error } = await query
      .order(orderColumn, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return { rows, truncated: false, error: error.message };
    // supabase-js types a dynamic string select as GenericStringError[];
    // the runtime payload is the plain row objects. Cast via unknown.
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
    if (rows.length >= maxRows) return { rows, truncated: true, error: null };
  }
  return { rows, truncated: false, error: null };
}

export interface HistoryWeekListItem extends HistoryWeekSummary {
  /** Scan-runs in this week (from offer_scan_runs when reachable; otherwise
   *  falls back to snapshotCount, which is 1:1 with scan attempts). */
  scanRunCount: number;
  /** Latest started_at from offer_scan_runs, else latest observed_at. */
  latestRunAt: string | null;
}

export interface HistoryWeeksResult {
  available: boolean;
  generatedAt: string;
  /** True only when offer_scan_runs is reachable (post-push). */
  scanRunsAvailable: boolean;
  /** True if the paged read hit the safety cap (very large history). */
  truncated: boolean;
  weeks: HistoryWeekListItem[];
  error: string | null;
}

/**
 * Build the calendar-week overview. Reads the (small) projection
 * `observed_at, snapshot_id, store_name, source, source_external_id` over
 * the full offer_history table, aggregates per ISO week and enriches each
 * week with scan-run counts when the ledger table exists.
 */
export async function getHistoryWeeks(): Promise<HistoryWeeksResult> {
  const generatedAt = new Date().toISOString();
  const client = getClient();
  if (!client) {
    return {
      available: false,
      generatedAt,
      scanRunsAvailable: false,
      truncated: false,
      weeks: [],
      error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nicht gesetzt.',
    };
  }
  const read = await readOfferHistoryPaged(client, {
    select: 'observed_at, snapshot_id, store_name, source, source_external_id',
  });
  if (read.error) {
    return {
      available: false,
      generatedAt,
      scanRunsAvailable: false,
      truncated: false,
      weeks: [],
      error: read.error,
    };
  }
  const baseWeeks = aggregateHistoryWeeks(read.rows as WeekCountableRow[]);

  // Enrich with scan-run counts per ISO week when the table is reachable.
  let scanRunsAvailable = false;
  const runByWeek = new Map<string, { count: number; latest: string | null }>();
  const { data: runData, error: runError } = await client
    .from('offer_scan_runs')
    .select('iso_year, iso_week, started_at')
    .order('started_at', { ascending: false })
    .limit(5000);
  if (!runError && Array.isArray(runData)) {
    scanRunsAvailable = true;
    for (const r of runData as Array<Record<string, unknown>>) {
      const wk = `${Number(r.iso_year)}-${Number(r.iso_week)}`;
      const entry = runByWeek.get(wk) ?? { count: 0, latest: null };
      entry.count += 1;
      const started = r.started_at ? String(r.started_at) : null;
      if (started && (!entry.latest || started > entry.latest)) entry.latest = started;
      runByWeek.set(wk, entry);
    }
  }

  const weeks: HistoryWeekListItem[] = baseWeeks.map((w) => {
    const run = runByWeek.get(`${w.isoYear}-${w.isoWeek}`);
    return {
      ...w,
      scanRunCount: run ? run.count : w.snapshotCount,
      latestRunAt: run?.latest ?? w.latestObservedAt,
    };
  });

  return {
    available: true,
    generatedAt,
    scanRunsAvailable,
    truncated: read.truncated,
    weeks,
    error: null,
  };
}

export interface HistoryWeekDetailResult {
  available: boolean;
  generatedAt: string;
  isoYear: number;
  isoWeek: number;
  weekStartDate: string;
  weekEndDate: string;
  snapshotCount: number;
  scanRunCount: number;
  offerCount: number;
  storeCount: number;
  stores: string[];
  /** Total product×store groups in the week (before the limit). */
  totalGroups: number;
  /** Groups actually returned (after the limit). */
  returnedGroups: number;
  /** True when totalGroups exceeded the requested limit. */
  limited: boolean;
  /** True when the paged read hit the safety cap. */
  truncatedRead: boolean;
  offers: WeekOfferGroup[];
  error: string | null;
}

function emptyWeekDetail(
  generatedAt: string,
  range: Pick<IsoWeekRange, 'isoYear' | 'isoWeek' | 'weekStartDate' | 'weekEndDate'>,
  available: boolean,
  error: string | null,
): HistoryWeekDetailResult {
  return {
    available,
    generatedAt,
    isoYear: range.isoYear,
    isoWeek: range.isoWeek,
    weekStartDate: range.weekStartDate,
    weekEndDate: range.weekEndDate,
    snapshotCount: 0,
    scanRunCount: 0,
    offerCount: 0,
    storeCount: 0,
    stores: [],
    totalGroups: 0,
    returnedGroups: 0,
    limited: false,
    truncatedRead: false,
    offers: [],
    error,
  };
}

/**
 * Load the aggregated offers for a single ISO week. Reads the full set of
 * history rows whose `observed_at` falls in [Monday, next-Monday) and groups
 * them per product×store. `limit` caps the number of returned groups so the
 * dashboard stays fast; `totalGroups`/`limited` tell the UI how many were
 * elided.
 */
export async function getHistoryWeekDetail(input: {
  year: number;
  week: number;
  limit?: number;
}): Promise<HistoryWeekDetailResult> {
  const generatedAt = new Date().toISOString();
  let range: IsoWeekRange;
  try {
    range = isoWeekToDateRange(input.year, input.week);
  } catch (e) {
    return emptyWeekDetail(
      generatedAt,
      {
        isoYear: input.year,
        isoWeek: input.week,
        weekStartDate: '',
        weekEndDate: '',
      },
      false,
      (e as Error).message,
    );
  }
  const limit = Math.min(Math.max(1, (input.limit ?? 200) | 0), 1000);
  const client = getClient();
  if (!client) {
    return emptyWeekDetail(
      generatedAt,
      range,
      false,
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nicht gesetzt.',
    );
  }
  const read = await readOfferHistoryPaged(client, {
    select:
      'snapshot_id, observed_at, canonical_product_key, store_name, product_name, brand, category, image_url, price, original_price, savings_percent, valid_until, source, source_external_id',
    gte: { column: 'observed_at', value: range.startIso },
    lt: { column: 'observed_at', value: range.endExclusiveIso },
  });
  if (read.error) {
    return emptyWeekDetail(generatedAt, range, false, read.error);
  }
  const rows = read.rows;
  const groups = aggregateWeekOffers(rows as WeekOfferRow[]);

  const snapshots = new Set<string>();
  const stores = new Set<string>();
  const offers = new Set<string>();
  for (const r of rows) {
    const snapshotId = trimToNull(r.snapshot_id);
    if (snapshotId) snapshots.add(snapshotId);
    const storeName = trimToNull(r.store_name);
    if (storeName) stores.add(storeName);
    const externalId = trimToNull(r.source_external_id);
    if (externalId) offers.add(`${trimToNull(r.source) ?? ''}:${externalId}`);
  }

  // Prefer the authoritative scan-run count for the week if the ledger is
  // reachable; otherwise distinct snapshots is the best proxy.
  let scanRunCount = snapshots.size;
  const { count, error: countError } = await client
    .from('offer_scan_runs')
    .select('id', { count: 'exact', head: true })
    .eq('iso_year', range.isoYear)
    .eq('iso_week', range.isoWeek);
  if (!countError && typeof count === 'number') scanRunCount = count;

  const limited = groups.length > limit;
  const returned = limited ? groups.slice(0, limit) : groups;

  return {
    available: true,
    generatedAt,
    isoYear: range.isoYear,
    isoWeek: range.isoWeek,
    weekStartDate: range.weekStartDate,
    weekEndDate: range.weekEndDate,
    snapshotCount: snapshots.size,
    scanRunCount,
    offerCount: offers.size,
    storeCount: stores.size,
    stores: [...stores].sort((a, b) => a.localeCompare(b)),
    totalGroups: groups.length,
    returnedGroups: returned.length,
    limited,
    truncatedRead: read.truncated,
    offers: returned,
    error: null,
  };
}
