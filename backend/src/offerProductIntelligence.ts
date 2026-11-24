// Product-intelligence reuse + incremental KI-scan selection.
//
// The classic "Alles neu mit KI prüfen" run sends EVERY offer through the
// Python/Ollama pipeline — correct, but slow (a 14B re-analyses identical
// products in every store and every week). These pure helpers power the new
// "Nur neue/unklare prüfen" mode:
//
//   1. A stable PRODUCT KEY (normalizedName + brand + size/unit + barcode) that
//      is the SAME for one product across stores and weeks — unlike the per-offer
//      `offerFingerprint`, which also folds in chain/price/validity and therefore
//      changes every week.
//   2. Candidate selection: only offers whose AI analysis is missing, uncertain,
//      stale (old version) or invalidated (product key changed) are processed;
//      everything already good is skipped.
//   3. Cross-store / cross-offer reuse: the analysis of one product is copied to
//      its siblings (same product key) instead of re-running the model — while
//      store, price, discount, validity and week stay per offer.
//
// Everything here is pure and IO-free so it is fully unit-testable and server.ts
// can keep the heavy lifting (Python pipeline, snapshot, HTTP).

import type { Offer } from '../../src/types/models';

/**
 * Bump this when the prompt/model/enrichment logic changes in a way that should
 * invalidate previously-stamped analyses. Offers stamped with a different
 * version are treated as stale and re-analysed by the incremental mode.
 */
export const PRODUCT_INTELLIGENCE_VERSION = 'pi-v2';

/** Default minimum canonical-category confidence to treat an offer as "sure". */
export const DEFAULT_MIN_CATEGORY_CONFIDENCE = 0.6;

/** Category values that count as "no real category" (still needs the model). */
const FALLBACK_CATEGORIES = new Set(['', 'sonstiges', 'unbekannt', 'unknown', 'other']);

/** Stamp written onto an offer once it carries a current analysis, so a later
 *  incremental run can tell up-to-date offers from stale / changed ones. */
export interface ProductIntelligenceMeta {
  productKey: string;
  version: string;
  analyzedAt: string;
  /** How the analysis was produced:
   *  - "ai":    really classified by the model (llm / versioned cache hit)
   *  - "rule":  rule/fallback result — MUST NOT be presented as KI
   *  - "reuse": copied from a sibling product's analysis */
  source: 'ai' | 'rule' | 'reuse';
  model?: string;
}

/** The AI/enrichment payload the Python pipeline writes onto each offer. These
 *  are the PRODUCT-level fields that may be reused across stores; per-offer data
 *  (price, validity, store, week, fingerprint, availability) is never copied. */
interface AnalysisFields {
  canonicalCategory?: unknown;
  category?: string;
  foodFlag?: unknown;
  foodReasons?: unknown;
  nonfoodReasons?: unknown;
  nutrition?: unknown;
  allergens?: unknown;
  dietFlags?: unknown;
  /** Phase 2.0 ProductAnalysisV2 — the single evidence-based truth the Python
   *  pipeline attaches; dietFlags/allergens are derived from it. Product-level,
   *  so it is reused across the same product key (per P9). */
  productAnalysis?: unknown;
  categorySuspects?: unknown;
  reviewNeeded?: unknown;
  reviewReason?: unknown;
  reviewReasons?: unknown;
  aiMeta?: ProductIntelligenceMeta;
}

/** An Offer plus the optional analysis fields that ride along on the snapshot. */
export type IntelligenceOffer = Offer & AnalysisFields & Record<string, unknown>;

/** The product-level analysis fields copied on reuse. Per-offer identity, price,
 *  validity, store, week, availability and fingerprint are intentionally absent. */
export const PRODUCT_ANALYSIS_FIELDS = [
  'canonicalCategory',
  'category',
  'foodFlag',
  'foodReasons',
  'nonfoodReasons',
  'nutrition',
  'allergens',
  'dietFlags',
  'productAnalysis',
  'categorySuspects',
  'reviewNeeded',
  'reviewReason',
  'reviewReasons',
] as const;

export type SelectionStatus = 'locked' | 'up_to_date' | 'candidate';

export interface OfferEvaluation {
  status: SelectionStatus;
  /** Machine-readable reasons it is a candidate (empty for up_to_date/locked). */
  reasons: string[];
  productKey: string;
}

export interface SelectionOptions {
  minCategoryConfidence?: number;
  version?: string;
}

// ---------------------------------------------------------------------------
// Normalisation + product key
// ---------------------------------------------------------------------------

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    // strip combining diacritic marks so accented inputs collapse (ü→u)
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Read the first present, non-empty value among several candidate field names. */
function firstField(offer: IntelligenceOffer, names: readonly string[]): string {
  for (const name of names) {
    const raw = offer[name];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  }
  return '';
}

/**
 * Stable product key shared by the same product across stores/weeks.
 *
 * A barcode (gtin/ean) is globally unique, so when present it alone is the key.
 * Otherwise the key is normalizedName + brand + package size/unit. Per-offer
 * data (chain, price, validity) is deliberately NOT part of the key — that is
 * what keeps it stable week to week (unlike `offerFingerprint`).
 */
export function productKeyForOffer(offer: Offer): string {
  const o = offer as IntelligenceOffer;
  const barcode = firstField(o, ['barcode', 'gtin', 'ean', 'gtinOrEan']);
  if (barcode) {
    return `bc:${normalizeText(barcode).replace(/\s+/g, '')}`;
  }
  const name = normalizeText(o.normalizedName || o.name);
  const brand = normalizeText(o.brand);
  const size = normalizeText(firstField(o, ['packageSize', 'size', 'unit']) + ' ' + (o.baseUnit ?? ''));
  return `nm:${name}|br:${brand}|sz:${size}`;
}

// ---------------------------------------------------------------------------
// Analysis presence / quality
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function categoryConfidence(offer: IntelligenceOffer): number | null {
  const cc = asRecord(offer.canonicalCategory);
  if (!cc) return null;
  const conf = Number(cc.confidence);
  return Number.isFinite(conf) ? conf : null;
}

function hasRealCategory(offer: IntelligenceOffer): boolean {
  const cc = asRecord(offer.canonicalCategory);
  if (cc && typeof cc.main === 'string' && cc.main.trim().length > 0) return true;
  const simple = normalizeText(offer.category);
  return simple.length > 0 && !FALLBACK_CATEGORIES.has(simple);
}

/**
 * Whether an offer carries manually-curated / locked analysis that the scan must
 * NEVER overwrite. This is the EDITORIAL lock (a human fixed the data), distinct
 * from `offerAvailability.status === 'locked'`, which is only a time-based
 * release lock and does not protect the analysis.
 */
export function isLockedOrManual(offer: Offer): boolean {
  const o = offer as IntelligenceOffer;
  return (
    o.aiLocked === true ||
    o.manualOverride === true ||
    o.manualReviewed === true ||
    o.reviewLocked === true
  );
}

/**
 * Classify a single offer for the incremental scan. An offer is a CANDIDATE when
 * any analysis field object is missing, the category is absent/low-confidence,
 * it is flagged for review, or its stamp shows a stale version / changed product
 * key. Locked/manual offers are never candidates and never reused-into.
 */
export function evaluateOffer(offer: Offer, options: SelectionOptions = {}): OfferEvaluation {
  const o = offer as IntelligenceOffer;
  const productKey = productKeyForOffer(offer);

  if (isLockedOrManual(offer)) {
    return { status: 'locked', reasons: [], productKey };
  }

  const minConf = options.minCategoryConfidence ?? DEFAULT_MIN_CATEGORY_CONFIDENCE;
  const version = options.version ?? PRODUCT_INTELLIGENCE_VERSION;
  const reasons: string[] = [];

  if (!hasRealCategory(o)) {
    reasons.push('category_missing');
  } else {
    const conf = categoryConfidence(o);
    if (conf !== null && conf < minConf) reasons.push('category_low_confidence');
  }

  // A never-analysed offer lacks these objects entirely; an analysed-but-empty
  // offer still HAS the object (source:"none") and is not re-queued for that.
  if (asRecord(o.nutrition) === null) reasons.push('nutrition_missing');
  if (asRecord(o.allergens) === null) reasons.push('allergens_missing');
  if (asRecord(o.dietFlags) === null) reasons.push('diet_missing');
  // ProductAnalysisV2 ist die EINE evidenzbasierte Wahrheit (dietFlags/allergens
  // werden daraus abgeleitet; die aichef_offers-Pipeline schreibt sie auf JEDES
  // verarbeitete Angebot). Ein Angebot ohne materialisierte productAnalysis —
  // Phase-1-Schnellkategorisierung (Legacy-Engine) oder Alt-Analyse vor pa-* —
  // muss nachgezogen werden; sonst bliebe es dauerhaft auf Legacy-Feldern und
  // würde sogar als Reuse-Donor akzeptiert.
  if (asRecord(o.productAnalysis) === null) reasons.push('product_analysis_missing');

  if (o.reviewNeeded === true) reasons.push('review_needed');

  const meta = o.aiMeta;
  if (meta && typeof meta === 'object') {
    if (meta.version !== version) reasons.push('stale_version');
    if (meta.productKey && meta.productKey !== productKey) reasons.push('product_changed');
  }

  return {
    status: reasons.length > 0 ? 'candidate' : 'up_to_date',
    reasons,
    productKey,
  };
}

export interface CandidateSelection<T extends Offer> {
  /** Offers needing (re)analysis. */
  candidates: T[];
  /** Offers whose analysis is good + current — skipped. */
  upToDate: T[];
  /** Editorially locked offers — skipped, never overwritten. */
  locked: T[];
  /** id → reasons for the candidates (for status/debug). */
  reasons: Map<string, string[]>;
}

/** Partition offers into candidates / up-to-date / locked. */
export function selectAiCandidates<T extends Offer>(
  offers: readonly T[],
  options: SelectionOptions = {},
): CandidateSelection<T> {
  const candidates: T[] = [];
  const upToDate: T[] = [];
  const locked: T[] = [];
  const reasons = new Map<string, string[]>();

  for (const offer of offers) {
    const evaln = evaluateOffer(offer, options);
    if (evaln.status === 'locked') {
      locked.push(offer);
    } else if (evaln.status === 'up_to_date') {
      upToDate.push(offer);
    } else {
      candidates.push(offer);
      reasons.set(offer.id, evaln.reasons);
    }
  }

  return { candidates, upToDate, locked, reasons };
}

// ---------------------------------------------------------------------------
// Product-analysis index + reuse
// ---------------------------------------------------------------------------

/**
 * Build a productKey → best-analysed-offer index from offers that already hold a
 * GOOD, current analysis (so reuse never spreads uncertain data). Only the
 * highest-category-confidence offer per key is kept as the donor.
 */
export function buildProductAnalysisIndex<T extends Offer>(
  offers: readonly T[],
  options: SelectionOptions = {},
): Map<string, T> {
  const index = new Map<string, T>();
  for (const offer of offers) {
    const evaln = evaluateOffer(offer, options);
    // Only confident, non-candidate, non-locked offers are valid donors.
    if (evaln.status !== 'up_to_date') continue;
    const key = evaln.productKey;
    const existing = index.get(key);
    if (!existing) {
      index.set(key, offer);
      continue;
    }
    const a = categoryConfidence(existing as IntelligenceOffer) ?? 0;
    const b = categoryConfidence(offer as IntelligenceOffer) ?? 0;
    if (b > a) index.set(key, offer);
  }
  return index;
}

/**
 * Copy the product-level analysis fields from `donor` onto `target`, keeping all
 * of `target`'s per-offer identity/price/validity/store/week data. Stamps a
 * fresh `aiMeta` so the result is recognised as up-to-date next time.
 */
export function applyProductAnalysis<T extends Offer>(
  target: T,
  donor: Offer,
  options: { now?: string; version?: string; model?: string } = {},
): T {
  const out = { ...(target as IntelligenceOffer) };
  const src = donor as IntelligenceOffer;
  for (const field of PRODUCT_ANALYSIS_FIELDS) {
    if (src[field] !== undefined) {
      (out as Record<string, unknown>)[field] = src[field];
    }
  }
  out.aiMeta = {
    productKey: productKeyForOffer(target),
    version: options.version ?? PRODUCT_INTELLIGENCE_VERSION,
    analyzedAt: options.now ?? new Date().toISOString(),
    source: 'reuse',
    model: options.model,
  };
  // out is a clone of `target` (T) with extra analysis fields layered on; the
  // double cast is needed because T may be a narrower subtype of Offer.
  return out as unknown as T;
}

/**
 * The current ProductAnalysisV2 rules version and fingerprint prefix that the
 * Python `source_fingerprint` stamps. A reuse is only safe when BOTH offers
 * carry a fingerprint of this generation — an older stamp is treated as
 * version-mismatch (P4).
 *
 * MUSS exakt `RULES_VERSION` / dem Fingerprint-Präfix in
 * `aichef_offers/product_analysis.py` folgen. Ein vergessener Mitzug (wie beim
 * pa-v7-Bump) schaltet den Cross-Store-Reuse KOMPLETT ab: jede aktuelle Analyse
 * gilt dann fälschlich als version_mismatch und jeder Kandidat geht ans Modell.
 * Ein Drift-Guard-Test liest die Python-Quelle und erzwingt die Gleichheit.
 */
export const PRODUCT_ANALYSIS_RULES_VERSION = 'pa-v7';
export const PRODUCT_ANALYSIS_FINGERPRINT_PREFIX = 'sf5:';

/** Read `productAnalysis.sourceFingerprint` (the authoritative Python fingerprint). */
function storedFingerprint(offer: IntelligenceOffer): string | null {
  const pa = asRecord(offer.productAnalysis);
  const fp = pa?.sourceFingerprint;
  return typeof fp === 'string' && fp.length > 0 ? fp : null;
}

/** Read the analysis' rules version (rulesVersion, falling back to analysisVersion). */
function rulesVersionOf(offer: IntelligenceOffer): string | null {
  const pa = asRecord(offer.productAnalysis);
  if (!pa) return null;
  const v = pa.rulesVersion ?? pa.analysisVersion;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** A fingerprint is current only with the sf5: prefix AND the pa-v6 rules version. */
function isCurrentFingerprint(fp: string | null, version: string | null): boolean {
  return (
    fp !== null &&
    fp.startsWith(PRODUCT_ANALYSIS_FINGERPRINT_PREFIX) &&
    version === PRODUCT_ANALYSIS_RULES_VERSION
  );
}

/** Why a same-product-key donor could (not) be reused for a candidate (P4). */
export type ReuseDiagnosis =
  | 'reuse'
  | 'fingerprint_missing'
  | 'fingerprint_mismatch'
  | 'fingerprint_version_mismatch';

export type ReuseRejectionReason = Exclude<ReuseDiagnosis, 'reuse'>;

/**
 * Decide whether a donor's ProductAnalysisV2 may be reused for a candidate.
 *
 * Safety rule (P4): cross-store reuse requires a VERIFIABLE, compatible Python
 * `sourceFingerprint`. A matching `productKey` alone is never enough, and an
 * incomplete TypeScript substitute signature must not claim compatibility — so
 * there is NO evidence-signature fallback anymore. The diagnosis distinguishes:
 *   - `fingerprint_missing`         — donor or candidate has no Python fingerprint
 *   - `fingerprint_version_mismatch`— a stale rules/fingerprint generation (sf1/pa-v2)
 *   - `fingerprint_mismatch`        — both current but the fingerprints differ
 *   - `reuse`                       — both carry the SAME current Python fingerprint
 */
export function classifyReuse(donor: Offer, candidate: Offer): ReuseDiagnosis {
  const d = donor as IntelligenceOffer;
  const c = candidate as IntelligenceOffer;
  const df = storedFingerprint(d);
  const cf = storedFingerprint(c);
  if (df === null || cf === null) return 'fingerprint_missing';
  if (!isCurrentFingerprint(df, rulesVersionOf(d)) || !isCurrentFingerprint(cf, rulesVersionOf(c))) {
    return 'fingerprint_version_mismatch';
  }
  if (df !== cf) return 'fingerprint_mismatch';
  return 'reuse';
}

export interface ReuseRejection<T extends Offer> {
  offer: T;
  /** Why reuse was refused even though a same-key donor existed. */
  reason: ReuseRejectionReason;
}

export interface ReuseResult<T extends Offer> {
  /** Candidates that were filled from a sibling analysis (no model needed). */
  reused: T[];
  /** Candidates with no donor OR an incompatible donor — must go to the model. */
  stillNeedAi: T[];
  /** Diagnostic: same-key donors rejected because the evidence diverged. */
  rejected: ReuseRejection<T>[];
}

/**
 * For each candidate, reuse a donor analysis from the index when one exists for
 * its product key AND the source fingerprint / evidence is compatible; otherwise
 * leave it for the model. Cache-hit (reused), cache-miss (no donor) and rejection
 * (same key, divergent evidence) are all surfaced for diagnostics.
 */
export function reuseProductAnalysis<T extends Offer>(
  candidates: readonly T[],
  index: Map<string, Offer>,
  options: { now?: string; version?: string; model?: string } = {},
): ReuseResult<T> {
  const reused: T[] = [];
  const stillNeedAi: T[] = [];
  const rejected: ReuseRejection<T>[] = [];
  for (const offer of candidates) {
    const donor = index.get(productKeyForOffer(offer));
    if (!donor) {
      stillNeedAi.push(offer);
      continue;
    }
    const diagnosis = classifyReuse(donor, offer);
    if (diagnosis !== 'reuse') {
      // Same product key, but no verifiable compatible Python fingerprint — never
      // copy a stale verdict; force a fresh analysis instead (P4).
      rejected.push({ offer, reason: diagnosis });
      stillNeedAi.push(offer);
      continue;
    }
    reused.push(applyProductAnalysis(offer, donor, options));
  }
  return { reused, stillNeedAi, rejected };
}

/**
 * Pick one representative per product key from the offers that must go to the
 * model, so identical products are analysed once. The non-representatives are
 * returned as `followers` and get the representative's result copied afterwards.
 */
export function dedupeByProductKey<T extends Offer>(
  offers: readonly T[],
): { representatives: T[]; followers: T[] } {
  const seen = new Set<string>();
  const representatives: T[] = [];
  const followers: T[] = [];
  for (const offer of offers) {
    const key = productKeyForOffer(offer);
    if (seen.has(key)) {
      followers.push(offer);
    } else {
      seen.add(key);
      representatives.push(offer);
    }
  }
  return { representatives, followers };
}

/**
 * Whether an offer's category was really produced by the model — a fresh "llm"
 * reason or a versioned "cache:hit". Rule/fallback and conflict-corrected results
 * (their KI markers are stripped in Python) return false, so they are never
 * mislabelled as KI.
 */
export function wasAiClassified(offer: Offer): boolean {
  const cc = asRecord((offer as IntelligenceOffer).canonicalCategory);
  const reasons = cc?.reasons;
  if (!Array.isArray(reasons)) return false;
  return reasons.some((r) => {
    const s = String(r).toLowerCase();
    return s === 'llm' || s.includes('llm') || s === 'cache:hit';
  });
}

/**
 * Stamp the analysis marker, choosing the source HONESTLY from the offer's own
 * reasons: "ai" only when really model-classified, otherwise "rule". This is the
 * fix for fallback offers being stamped source:"ai".
 */
export function stampAnalysisMeta<T extends Offer>(
  offer: T,
  options: { now?: string; version?: string; model?: string } = {},
): T {
  const out = { ...(offer as IntelligenceOffer) };
  out.aiMeta = {
    productKey: productKeyForOffer(offer),
    version: options.version ?? PRODUCT_INTELLIGENCE_VERSION,
    analyzedAt: options.now ?? new Date().toISOString(),
    source: wasAiClassified(offer) ? 'ai' : 'rule',
    model: options.model,
  };
  return out as unknown as T;
}

/** Stamp a fresh AI analysis marker (source "ai") — only for offers known to be
 *  model-classified. Prefer {@link stampAnalysisMeta} which decides the source. */
export function stampAiMeta<T extends Offer>(
  offer: T,
  options: { now?: string; version?: string; model?: string } = {},
): T {
  const out = { ...(offer as IntelligenceOffer) };
  out.aiMeta = {
    productKey: productKeyForOffer(offer),
    version: options.version ?? PRODUCT_INTELLIGENCE_VERSION,
    analyzedAt: options.now ?? new Date().toISOString(),
    source: 'ai',
    model: options.model,
  };
  return out as unknown as T;
}

// ---------------------------------------------------------------------------
// Food / non-food split (mirrors offersCategorizerBridge for reused offers)
// ---------------------------------------------------------------------------

/** Whether an offer is flagged non-food (same rule as the categorizer bridge). */
export function isNonFoodOffer(offer: Offer): boolean {
  const o = offer as IntelligenceOffer;
  if (typeof o.foodFlag === 'string') return o.foodFlag === 'nonfood';
  const cc = asRecord(o.canonicalCategory);
  return cc?.isNonFood === true;
}

/** Split offers into food (live) and non-food (filtered) buckets. */
export function splitFoodAndNonFood<T extends Offer>(
  offers: readonly T[],
): { food: T[]; nonFood: T[] } {
  const food: T[] = [];
  const nonFood: T[] = [];
  for (const offer of offers) {
    if (isNonFoodOffer(offer)) nonFood.push(offer);
    else food.push(offer);
  }
  return { food, nonFood };
}

/** Count offers still uncertain (review-needed or low/again-missing category)
 *  after a run — surfaced as `uncertainRemaining` in the status. */
export function countUncertain(offers: readonly Offer[], options: SelectionOptions = {}): number {
  let count = 0;
  for (const offer of offers) {
    const evaln = evaluateOffer(offer, options);
    if (evaln.status === 'candidate') count += 1;
  }
  return count;
}

export interface IncrementalScanPlan {
  /** Offers selected as missing/uncertain/stale. */
  candidatesSelected: number;
  /** Candidates that could be filled from a sibling product (no model). */
  reusableFromCache: number;
  /** Distinct products that would actually be sent to the model. */
  sentToModel: number;
  /** Already good + current (skipped). */
  skippedUpToDate: number;
  /** Editorially locked (skipped, never overwritten). */
  skippedLocked: number;
}

/**
 * Plan an incremental ("missing_or_uncertain") run WITHOUT any IO: how many
 * offers are candidates, how many reuse an existing analysis, and how many
 * distinct products would actually be sent to the model. Powers the dryRun
 * endpoint and the all-stores guard sizing.
 */
export function planIncrementalScan<T extends Offer>(
  offers: readonly T[],
  options: SelectionOptions = {},
): IncrementalScanPlan {
  const selection = selectAiCandidates(offers, options);
  const index = buildProductAnalysisIndex([...selection.upToDate, ...selection.locked], options);
  const { reused, stillNeedAi } = reuseProductAnalysis(selection.candidates, index);
  const { representatives } = dedupeByProductKey(stillNeedAi);
  return {
    candidatesSelected: selection.candidates.length,
    reusableFromCache: reused.length,
    sentToModel: representatives.length,
    skippedUpToDate: selection.upToDate.length,
    skippedLocked: selection.locked.length,
  };
}
