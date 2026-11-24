// Shared derivation of the "deal-facing" fields the Cheffity mobile app expects
// from an enriched Offer. Both the API serializer (server.ts) and the Supabase
// sync (services/supabaseDealsSync.ts) use this so the two stay in lock-step.
//
// The enrichment shape comes from the `aichef_offers` Python pipeline, which
// attaches (when its --nutrition/--diet/--halal flags are on):
//   offer.nutrition  = { source, per_100g: { kcal, protein_g, ... }, ... }
//   offer.allergens  = { contains: string[], may_contain: string[], ... }
//   offer.dietFlags  = { halal: { status }, alcohol?: { present }, vegetarian, vegan, ... }
// Plain offers (offers_categorizer engine, or flags off) carry none of these,
// so every field degrades cleanly to null — never a fake value.

import type { Offer } from '../../src/types/models';
import { detectAlcohol, detectAllergenRisks } from './dietHeuristics';
import type { EnrichmentCategory } from './enrichmentFlags';

export type Allergen =
  | 'gluten' | 'lactose' | 'nuts' | 'eggs' | 'soy'
  | 'fish' | 'seafood' | 'sesame';

// Safe, app-facing status enums. They make the "unknown" case explicit so the
// mobile UI can show an honest "unklar"/"offen" chip instead of implying a fact
// the data does not support. Never fabricated — derived only from real fields.
export type NutritionStatus = 'verified' | 'estimated' | 'unknown';
export type HalalStatus = 'halal' | 'not_halal' | 'doubtful' | 'unknown';
export type AllergenStatus = 'known' | 'risk' | 'unknown';

export interface DealNutrition {
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  sugar: number | null;
  fiber: number | null;
  salt: number | null;
}

/** A single diet verdict projected verbatim from ProductAnalysisV2 — status,
 *  confidence and a short reason code. No re-decision happens here. */
export interface DietVerdict {
  status: string;
  confidence: number | null;
  reasonCode: string | null;
}

/** Thin, app-facing projection of the Python ProductAnalysisV2 truth. Every
 *  field is COPIED from `offer.productAnalysis`; this layer applies no diet/
 *  allergen/nutrition decision rules of its own (those live only in Python). */
export interface ProductAnalysisSummary {
  version: string | null;
  sourceFingerprint: string | null;
  vegan: DietVerdict;
  vegetarian: DietVerdict;
  halal: DietVerdict;
  reviewNeeded: boolean;
  reviewReasons: string[];
  allergens: { contains: string[]; mayContain: string[]; freeFrom: string[] };
  nutrition: { quality: string | null; basis: string | null; plausible: boolean | null };
  /** Distinct evidence sources actually used across the verdicts. */
  sources: string[];
}

export interface DealEnrichment {
  originalPrice: number | null;
  savingsPercent: number | null;
  savingsAbsolute: number | null;
  nutrition: DealNutrition | null;
  nutritionEstimated: boolean;
  allergens: Allergen[];
  /** Name/category-derived *risk* allergens (never confirmed facts). Drives
   *  allergenStatus = 'risk'; distinct from the verified `allergens` list. */
  allergenRisks: Allergen[];
  isHalal: boolean | null;
  containsAlcohol: boolean | null;
  /** Explicit-only diet flags from the pipeline; null = the source never said. */
  isVegan: boolean | null;
  isVegetarian: boolean | null;
  ingredients: string[];
  storeLogoUrl: string | null;
  // Derived, never-fabricated status summaries for the app's "Produktinfos".
  nutritionStatus: NutritionStatus;
  halalStatus: HalalStatus;
  allergenStatus: AllergenStatus;
  /** True once an offer has been through this honest product-info derivation,
   *  even if every field stays "unknown" — lets the dashboard show "analysiert"
   *  without pretending the data is verified. */
  productInfoAnalyzed: boolean;
  /** Thin projection of ProductAnalysisV2 (or null when the offer carries none).
   *  Transport-only; the app reads it but never re-decides from it. */
  productAnalysis: ProductAnalysisSummary | null;
}

const VALID_ALLERGENS: ReadonlySet<Allergen> = new Set<Allergen>([
  'gluten', 'lactose', 'nuts', 'eggs', 'soy', 'fish', 'seafood', 'sesame',
]);

// Maps the allergen codes the `aichef_offers` pipeline emits (EU-14 keys like
// `gluten_cereals`, `milk`, `soybeans`, `peanuts`, `crustaceans`, `molluscs`)
// AND raw OpenFoodFacts tags (`en:milk`, `en:tree-nuts`) onto the app's 8
// supported allergen slugs. Without this, real verified allergen lists would be
// silently dropped because `mapAllergens` only accepted the app slugs.
//
// EU-14 keys the app has no dedicated bucket for (celery, mustard, sulphites,
// lupin) are intentionally not mapped — they fall through as "unknown" rather
// than being forced into a wrong bucket.
const ALLERGEN_ALIASES: Record<string, Allergen> = {
  // lactose / milk
  milk: 'lactose', lactose: 'lactose', dairy: 'lactose',
  // gluten / cereals
  gluten: 'gluten', gluten_cereals: 'gluten', cereals: 'gluten', wheat: 'gluten',
  barley: 'gluten', rye: 'gluten', oat: 'gluten', oats: 'gluten', spelt: 'gluten',
  // soy
  soy: 'soy', soya: 'soy', soybean: 'soy', soybeans: 'soy',
  // nuts (incl. peanuts — the app has only one nut bucket)
  nuts: 'nuts', nut: 'nuts', tree_nuts: 'nuts', treenuts: 'nuts',
  peanut: 'nuts', peanuts: 'nuts', almond: 'nuts', almonds: 'nuts',
  hazelnut: 'nuts', hazelnuts: 'nuts', walnut: 'nuts', walnuts: 'nuts',
  cashew: 'nuts', cashews: 'nuts', pistachio: 'nuts', pistachios: 'nuts',
  // fish
  fish: 'fish',
  // seafood (crustaceans + molluscs + shellfish)
  seafood: 'seafood', shellfish: 'seafood', crustacean: 'seafood',
  crustaceans: 'seafood', mollusc: 'seafood', molluscs: 'seafood',
  mollusks: 'seafood', shrimp: 'seafood', shrimps: 'seafood', prawns: 'seafood',
  // eggs
  eggs: 'eggs', egg: 'eggs',
  // sesame
  sesame: 'sesame', sesame_seeds: 'sesame', tahin: 'sesame', tahini: 'sesame',
};

/** Normalize an allergen token to the app's slug, or null if unsupported.
 *  Strips OFF locale prefixes (`en:`, `de:`) and unifies separators. */
function normalizeAllergenToken(raw: unknown): Allergen | null {
  let token = String(raw ?? '').toLowerCase().trim();
  if (!token) return null;
  // Drop an OpenFoodFacts locale prefix like "en:" / "de:".
  const colon = token.lastIndexOf(':');
  if (colon !== -1) token = token.slice(colon + 1);
  token = token.replace(/[\s-]+/g, '_').trim();
  if (VALID_ALLERGENS.has(token as Allergen)) return token as Allergen;
  return ALLERGEN_ALIASES[token] ?? null;
}

type EnrichedOffer = Offer & Record<string, unknown>;

function finiteOrNull(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

/** Round to `places` decimals, returning null for non-finite input. */
function round(value: number | null, places: number): number | null {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function mapAllergens(raw: unknown): Allergen[] {
  if (!Array.isArray(raw)) return [];
  const out: Allergen[] = [];
  for (const entry of raw) {
    const slug = normalizeAllergenToken(entry);
    if (slug && !out.includes(slug)) {
      out.push(slug);
    }
  }
  return out;
}

function mapNutrition(raw: unknown): { nutrition: DealNutrition | null; estimated: boolean } {
  if (!raw || typeof raw !== 'object') return { nutrition: null, estimated: false };
  const obj = raw as Record<string, unknown>;
  const per100 = (obj.per_100g ?? obj.per100g) as Record<string, unknown> | undefined;
  if (!per100 || typeof per100 !== 'object') return { nutrition: null, estimated: false };

  const nutrition: DealNutrition = {
    calories: round(finiteOrNull(per100.kcal ?? per100.calories), 0),
    protein: round(finiteOrNull(per100.protein_g ?? per100.protein), 1),
    carbs: round(finiteOrNull(per100.carbs_g ?? per100.carbs), 1),
    fat: round(finiteOrNull(per100.fat_g ?? per100.fat), 1),
    sugar: round(finiteOrNull(per100.sugars_g ?? per100.sugar), 1),
    fiber: round(finiteOrNull(per100.fiber_g ?? per100.fiber), 1),
    salt: round(finiteOrNull(per100.salt_g ?? per100.salt), 2),
  };

  // All-null means the source had nothing usable — treat as "no nutrition".
  const hasAny = Object.values(nutrition).some((v) => v !== null);
  if (!hasAny) return { nutrition: null, estimated: false };

  // OpenFoodFacts values are label-accurate; BLS / rule-based ones are estimates.
  const source = String(obj.source ?? '').toLowerCase();
  const estimated = source !== 'openfoodfacts' && source !== 'off';
  return { nutrition, estimated };
}

function mapHalal(offer: EnrichedOffer): boolean | null {
  const status = (offer.dietFlags as { halal?: { status?: string } } | undefined)?.halal?.status;
  if (status === 'yes') return true;
  if (status === 'no') return false;
  // Top-level isHalal override (e.g. a manual tag) if the pipeline set one.
  if (typeof offer.isHalal === 'boolean') return offer.isHalal;
  return null;
}

// Phase 2.0: the ProductAnalysisV2 truth carries the full 4-state halal status
// (halal / not_halal / doubtful / unknown). dietFlags.halal.statusV2 mirrors it
// for back-compat; productAnalysis.halal.status is the source. A definitive V2
// answer (incl. "doubtful") is preferred over the legacy yes/no derivation.
function mapHalalV2(offer: EnrichedOffer): HalalStatus | null {
  const v2 =
    (offer.dietFlags as { halal?: { statusV2?: string } } | undefined)?.halal?.statusV2 ??
    (offer.productAnalysis as { halal?: { status?: string } } | undefined)?.halal?.status;
  if (v2 === 'halal' || v2 === 'not_halal' || v2 === 'doubtful' || v2 === 'unknown') return v2;
  return null;
}

function mapAlcohol(offer: EnrichedOffer): boolean | null {
  const present = (offer.dietFlags as { alcohol?: { present?: boolean } } | undefined)?.alcohol?.present;
  if (typeof present === 'boolean') return present;
  if (typeof offer.containsAlcohol === 'boolean') return offer.containsAlcohol;
  // Honest fallback: assert alcohol only when the category/name make it clear.
  // Never returns `false` — absence of a signal stays "unknown" (null).
  if (detectAlcohol(offer)) return true;
  return null;
}

/** Risk-derived allergens mapped onto the app's Allergen union. */
function mapAllergenRisks(offer: EnrichedOffer): Allergen[] {
  const out: Allergen[] = [];
  for (const slug of detectAllergenRisks(offer)) {
    if (VALID_ALLERGENS.has(slug as Allergen) && !out.includes(slug as Allergen)) {
      out.push(slug as Allergen);
    }
  }
  return out;
}

function mapIngredients(offer: EnrichedOffer): string[] {
  const raw = offer.ingredients;
  if (!Array.isArray(raw)) return [];
  return raw.map((i) => String(i ?? '').trim()).filter((i) => i.length > 0);
}

// vegetarian/vegan are exposed ONLY when the source explicitly answered, never
// inferred from category or name (mirrors offersQuality.readDietFlag).
function mapDietFlag(offer: EnrichedOffer, key: 'vegetarian' | 'vegan'): boolean | null {
  const diet = offer.dietFlags as Record<string, unknown> | undefined;
  if (!diet || typeof diet !== 'object') return null;
  const direct = diet[key];
  if (typeof direct === 'boolean') return direct;
  if (typeof direct === 'string') {
    const lower = direct.toLowerCase();
    if (lower === 'yes' || lower === 'true') return true;
    if (lower === 'no' || lower === 'false') return false;
  }
  if (direct && typeof direct === 'object' && 'status' in direct) {
    const status = String((direct as { status: unknown }).status ?? '').toLowerCase();
    if (status === 'yes') return true;
    if (status === 'no') return false;
  }
  return null;
}

function deriveNutritionStatus(
  nutrition: DealNutrition | null,
  estimated: boolean,
): NutritionStatus {
  if (!nutrition) return 'unknown';
  return estimated ? 'estimated' : 'verified';
}

// Halal: a confirmed yes/no wins; detected alcohol makes it clearly not_halal
// (an alcoholic product is not halal); otherwise we honestly stay "unknown"
// (the app shows "Halal unklar"). We never claim "halal" just because no pork/
// alcohol was found.
function deriveHalalStatus(
  isHalal: boolean | null,
  containsAlcohol: boolean | null,
): HalalStatus {
  if (isHalal === true) return 'halal';
  if (isHalal === false) return 'not_halal';
  if (containsAlcohol === true) return 'not_halal';
  return 'unknown';
}

// Known allergens win; otherwise name-based risk allergens; otherwise unknown.
// "unknown" must never be presented as "allergen-free" in the UI.
function deriveAllergenStatus(
  allergens: Allergen[],
  allergenRisks: Allergen[],
): AllergenStatus {
  if (allergens.length > 0) return 'known';
  if (allergenRisks.length > 0) return 'risk';
  return 'unknown';
}

/** Read a string array field, defaulting to []. */
function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? '').trim()).filter((v) => v.length > 0);
}

/** Project ONE diet verdict ({ status, confidence, reasons }) from V2 — verbatim. */
function projectVerdict(raw: unknown): DietVerdict {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const status = typeof v.status === 'string' ? v.status : 'unknown';
  const confidence = finiteOrNull(v.confidence);
  const reasons = strArray(v.reasons);
  return { status, confidence, reasonCode: reasons.length > 0 ? reasons[0] : null };
}

/**
 * Thin projection of `offer.productAnalysis` (ProductAnalysisV2) for transport to
 * the app. Pure copy: it reads V2's own status/confidence/reasons/allergens/
 * nutrition and applies NO diet/allergen/nutrition logic of its own. Returns null
 * when the offer was never analysed by the V2 pipeline.
 */
export function mapProductAnalysisSummary(offer: EnrichedOffer): ProductAnalysisSummary | null {
  const pa = offer.productAnalysis;
  if (!pa || typeof pa !== 'object') return null;
  const a = pa as Record<string, unknown>;

  const vegan = projectVerdict(a.vegan);
  const vegetarian = projectVerdict(a.vegetarian);
  const halal = projectVerdict(a.halal);

  const allergensRaw = (a.allergens && typeof a.allergens === 'object' ? a.allergens : {}) as Record<string, unknown>;
  const contains: string[] = [];
  const mayContain: string[] = [];
  const freeFrom: string[] = [];
  const sources = new Set<string>();
  for (const [code, entry] of Object.entries(allergensRaw)) {
    const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const status = String(e.status ?? '');
    if (status === 'contains') contains.push(code);
    else if (status === 'may_contain') mayContain.push(code);
    else if (status === 'free_from_claim') freeFrom.push(code);
    if ((status === 'contains' || status === 'may_contain') && typeof e.source === 'string') sources.add(e.source);
  }
  for (const verdict of [a.vegan, a.vegetarian, a.halal]) {
    const src = (verdict as { source?: unknown } | undefined)?.source;
    if (typeof src === 'string' && src !== 'unknown') sources.add(src);
  }

  const nut = (a.nutrition && typeof a.nutrition === 'object' ? a.nutrition : {}) as Record<string, unknown>;
  const nutSource = typeof nut.source === 'string' ? nut.source : null;
  if (nutSource && nutSource !== 'unknown') sources.add(nutSource);
  const plaus = (nut.plausibility && typeof nut.plausibility === 'object' ? nut.plausibility : null) as
    | Record<string, unknown>
    | null;

  return {
    version: typeof a.analysisVersion === 'string' ? a.analysisVersion : null,
    sourceFingerprint: typeof a.sourceFingerprint === 'string' ? a.sourceFingerprint : null,
    vegan,
    vegetarian,
    halal,
    reviewNeeded: a.reviewNeeded === true,
    reviewReasons: strArray(a.reviewReasons),
    allergens: { contains: contains.sort(), mayContain: mayContain.sort(), freeFrom: freeFrom.sort() },
    nutrition: {
      quality: typeof nut.quality === 'string' ? nut.quality : null,
      basis: typeof nut.basis === 'string' ? nut.basis : null,
      plausible: plaus && typeof plaus.ok === 'boolean' ? plaus.ok : null,
    },
    sources: [...sources].sort(),
  };
}

/** Category state for `deriveDealEnrichment`'s optional suppression pass — see
 *  `enrichmentFlags.ts`. Defaults to "all enabled" so every existing caller
 *  (offersQuality.ts's coverage KPIs, supabaseDealsSync.ts's admin-panel sync)
 *  keeps seeing the true, unsuppressed data; only the app-facing API
 *  serializer (server.ts's `toApiOffer`) passes the live admin-configured
 *  flags. */
const ALL_ENRICHMENT_ENABLED: Record<EnrichmentCategory, boolean> = {
  nutrition: true,
  halal: true,
  allergens: true,
};

/**
 * Suppress a disabled category's raw field AND every field derived from it —
 * including inside `productAnalysis`, which would otherwise re-expose the same
 * verdict through a second field. Never partial: a disabled category always
 * degrades to the same honest "unknown" shape the app already renders for
 * offers that were never analyzed, so no app-side change is needed to respect
 * this.
 */
function applyEnrichmentFlags(
  enrichment: DealEnrichment,
  flags: Record<EnrichmentCategory, boolean>,
): DealEnrichment {
  const result = { ...enrichment };
  if (!flags.nutrition) {
    result.nutrition = null;
    result.nutritionEstimated = false;
    result.nutritionStatus = 'unknown';
    if (result.productAnalysis) {
      result.productAnalysis = {
        ...result.productAnalysis,
        nutrition: { quality: null, basis: null, plausible: null },
      };
    }
  }
  if (!flags.halal) {
    result.isHalal = null;
    result.halalStatus = 'unknown';
    if (result.productAnalysis) {
      result.productAnalysis = {
        ...result.productAnalysis,
        halal: { status: 'unknown', confidence: null, reasonCode: null },
      };
    }
  }
  if (!flags.allergens) {
    result.allergens = [];
    result.allergenRisks = [];
    result.allergenStatus = 'unknown';
    if (result.productAnalysis) {
      result.productAnalysis = {
        ...result.productAnalysis,
        allergens: { contains: [], mayContain: [], freeFrom: [] },
      };
    }
  }
  return result;
}

/**
 * Derive the normalized deal fields from a (possibly enriched) offer.
 * Pure + null-safe: missing data yields null/[] rather than fabricated values.
 * `flags` (default: all enabled) lets an admin-disabled category degrade to
 * the same honest "unknown" shape as an unanalyzed offer — see
 * `applyEnrichmentFlags`.
 */
export function deriveDealEnrichment(
  offer: EnrichedOffer,
  flags: Record<EnrichmentCategory, boolean> = ALL_ENRICHMENT_ENABLED,
): DealEnrichment {
  const currentPrice = finiteOrNull(offer.price) ?? 0;
  const originalPrice = finiteOrNull(offer.originalPrice);

  let savingsPercent: number | null = finiteOrNull(offer.savingsPercent);
  let savingsAbsolute: number | null = null;
  if (originalPrice !== null && originalPrice > currentPrice && originalPrice > 0) {
    savingsAbsolute = round(originalPrice - currentPrice, 2);
    if (savingsPercent === null) {
      savingsPercent = round(((originalPrice - currentPrice) / originalPrice) * 100, 0);
    }
  }

  const { nutrition, estimated } = mapNutrition(offer.nutrition);
  const allergensSource = (offer.allergens as { contains?: unknown } | undefined)?.contains;
  const allergens = mapAllergens(allergensSource);
  const allergenRisks = mapAllergenRisks(offer);
  const isHalal = mapHalal(offer);
  const containsAlcohol = mapAlcohol(offer);
  // Prefer a definitive ProductAnalysisV2 status (incl. "doubtful"); fall back to
  // the legacy yes/no + alcohol heuristic only when V2 is absent or "unknown".
  const halalV2 = mapHalalV2(offer);
  const halalStatus =
    halalV2 && halalV2 !== 'unknown' ? halalV2 : deriveHalalStatus(isHalal, containsAlcohol);

  const enrichment: DealEnrichment = {
    originalPrice,
    savingsPercent,
    savingsAbsolute,
    nutrition,
    nutritionEstimated: estimated,
    allergens,
    allergenRisks,
    isHalal,
    containsAlcohol,
    isVegan: mapDietFlag(offer, 'vegan'),
    isVegetarian: mapDietFlag(offer, 'vegetarian'),
    ingredients: mapIngredients(offer),
    storeLogoUrl: typeof offer.storeLogoUrl === 'string' && offer.storeLogoUrl.trim()
      ? offer.storeLogoUrl.trim()
      : null,
    nutritionStatus: deriveNutritionStatus(nutrition, estimated),
    halalStatus,
    allergenStatus: deriveAllergenStatus(allergens, allergenRisks),
    productInfoAnalyzed: true,
    productAnalysis: mapProductAnalysisSummary(offer),
  };

  return applyEnrichmentFlags(enrichment, flags);
}
