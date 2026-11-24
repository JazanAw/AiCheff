// Pure data-quality auswertung über den aktuellen Offer-Snapshot.
//
// Operiert ausschließlich auf dem In-Memory-Snapshot (kein Supabase, kein
// Disk-IO) — alles ist O(N) über die Offers und ein einmaliger O(S)-Pass über
// die Stores. Bei 1k Angeboten erwartete Laufzeit < 10 ms.
//
// WICHTIG: Wenn ein Feld unbekannt ist, wird es als unknown gezählt, NIE
// erfunden. Halal/Allergene/Nutrition fehlen häufig, das ist Realität — die
// Quality-Auswertung soll genau diese Lücken sichtbar machen.

import type { Offer } from '../../src/types/models';
import { deriveDealEnrichment, type DealEnrichment } from './dealFields';
import { isAllergenRiskName, isAlcoholRiskName } from './dietHeuristics';

// Niedrige Live-Angebote pro Store sind ein klassisches Symptom für einen
// kaputten Scraper (z. B. Lidl mit nur 2 Treffern). Schwelle bewusst niedrig
// als Frühwarnung — die echten Stores haben meist > 30 Wochenangebote.
const LOW_STORE_OFFERS_THRESHOLD = 5;

// Schwellen für den Store-Status. Bewusst getrennt in ECHTE App-Blocker
// (führen zu "kritisch") und ANREICHERUNG (führt höchstens zu "prüfen").
//
// Blocker = Daten, ohne die ein Angebot in der App kaputt/unbrauchbar ist:
//   - zu wenige Angebote (Scraper tot)
//   - aktueller Angebotspreis fehlt (Karte ohne Preis ist sinnlos)
//   - Produktbild fehlt (Karte ohne Bild ist sinnlos)
//   - extrem viele Angebote ohne/falsche Kategorie (Filter unbrauchbar)
//
// Anreicherung = Zusatzdaten, deren Fehlen NORMAL ist, solange die Pipeline
// sie nicht aktiv befüllt (Nutrition/Halal/Allergene). Niemals "kritisch".
const STATUS_THRESHOLDS = {
  // unter diesem Wert fehlt zu vielen Angeboten der aktuelle Preis -> kritisch
  currentPriceCrit: 80,
  // Bild-Abdeckung
  imageCrit: 50,
  imageWarn: 90,
  // Anteil ohne/„other"-Kategorie
  categoryCrit: 50,
  categoryWarn: 25,
  // ab wann gilt Anreicherung als „offen" (rein informativ, gelb/neutral)
  enrichmentOpen: 30,
  // ab wann ein Store mit broken Bildern gewarnt wird (Anteil broken unter den
  // tatsächlich GEPRÜFTEN Bildern). Bewusst niedrig — kaputte Bilder fallen auf.
  brokenImageWarn: 5,
};

// Warum ein Store rot/gelb ist — maschinenlesbar, damit beide Dashboards (und
// Tests) denselben ehrlichen Grund anzeigen statt heuristisch nachzurechnen.
export type StoreStatusReason =
  // echte Blocker (crit)
  | 'low_offers'
  | 'missing_current_price'
  | 'missing_images'
  | 'uncategorized_high'
  // weiche Lücken (warn)
  | 'image_gaps'
  | 'broken_images'
  | 'uncategorized_some'
  // offene Zusatzdaten — kein Fehler, nur noch nicht angereichert
  | 'enrichment_pending';

export type StoreStatusTier = 'ok' | 'warn' | 'crit';

export interface StoreStatus {
  tier: StoreStatusTier;
  // erste, „schwerste" Begründung; Reihenfolge: crit vor warn vor enrichment.
  reasons: StoreStatusReason[];
}

export interface StoreQuality {
  storeChain: string;
  total: number;
  withImage: number;
  withImagePercent: number;
  // Ehrliche Bildqualität (Scan 2.0): "Bild vorhanden" (withImage) ist nicht
  // genug — eine URL kann 404 liefern (EDEKA-Fall). withReachableImage zählt nur
  // Bilder, die per Phase-1-Check erreichbar UND image/* sind; brokenImage zählt
  // vorhandene-aber-kaputte URLs. imageChecked = wie viele Bilder geprüft wurden
  // (0 ⇒ noch kein Scan-2.0-Bildcheck gelaufen, dann sind die Felder neutral).
  withReachableImage: number;
  withReachableImagePercent: number;
  brokenImage: number;
  brokenImagePercent: number;
  imageChecked: number;
  withCurrentPrice: number;
  withCurrentPricePercent: number;
  withOriginalPrice: number;
  withOriginalPricePercent: number;
  withSavingsPercent: number;
  withSavingsPercentPercent: number;
  withNutrition: number;
  withNutritionPercent: number;
  withAllergens: number;
  withAllergensPercent: number;
  halalKnown: number;
  halalKnownPercent: number;
  alcoholKnown: number;
  alcoholKnownPercent: number;
  vegetarianKnown: number;
  vegetarianKnownPercent: number;
  veganKnown: number;
  veganKnownPercent: number;
  withValidTo: number;
  withValidToPercent: number;
  withoutCategory: number;
  withoutCategoryPercent: number;
  lowOfferCount: boolean;
  status: StoreStatus;
}

export type ReviewReason =
  | 'no_image'
  | 'no_price'
  | 'no_category'
  | 'category_other'
  | 'no_nutrition'
  | 'halal_unknown'
  | 'alcohol_unknown_risk'
  | 'allergens_empty_risk'
  | 'name_fragment';

export interface ReviewItem {
  id: string;
  name: string;
  storeChain: string;
  category: string;
  price: number;
  imageUrl: string | null;
  sourceUrl: string;
  reasons: ReviewReason[];
}

export interface QualityKpis {
  liveTotal: number;
  filteredTotal: number;
  nextWeekTotal: number;
  storeCount: number;
  imageCoveragePercent: number;
  // Ehrliche Bild-KPIs (Scan 2.0): erreichbare Bilder vs. broken (404/kein image/*).
  // reachableImageCoveragePercent fällt auf imageCoveragePercent zurück, solange
  // noch kein Phase-1-Bildcheck gelaufen ist (imageCheckedTotal === 0).
  reachableImageCoveragePercent: number;
  brokenImageTotal: number;
  imageCheckedTotal: number;
  nutritionCoveragePercent: number;
  halalCoveragePercent: number;
  allergensCoveragePercent: number;
  updatedAt: string | null;
  lastIngest: QualityProcessState | null;
  lastAiRun: QualityProcessState | null;
}

export interface QualityProcessState {
  running: boolean;
  message: string | null;
  stage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

// Ehrliche Produktinfo-Auswertung. KEINE Coverage-Prozente, die "0 %" als
// Fehler aussehen lassen — stattdessen wird offen ausgewiesen, was verifiziert,
// geschätzt, als Risiko erkannt oder schlicht unbekannt ist. Jedes Live-Angebot
// wird gezählt als "analysiert" (analyzedTotal), auch wenn das Ergebnis unknown
// bleibt.
export interface ProductInfoSummary {
  analyzedTotal: number;
  nutritionVerified: number;
  nutritionEstimated: number;
  nutritionUnknown: number;
  halalKnown: number; // 'halal' ODER 'not_halal' = belastbare Aussage
  halalNotHalal: number;
  halalDoubtful: number;
  halalUnknown: number;
  allergenKnown: number;
  allergenRisk: number;
  allergenUnknown: number;
  alcoholDetected: number;
  veganCount: number;
  vegetarianCount: number;
}

export interface QualityReport {
  generatedAt: string;
  thresholds: {
    lowOfferCount: number;
  };
  kpis: QualityKpis;
  productInfo: ProductInfoSummary;
  stores: StoreQuality[];
  review: ReviewItem[];
  reviewCounts: Record<ReviewReason, number>;
}

export interface QualityInput {
  offers: Offer[];
  filteredOffers: Offer[];
  nextWeekOffers: Offer[];
  updatedAt: string | null;
  ingest?: Partial<QualityProcessState> | null;
  aiRun?: Partial<QualityProcessState> | null;
}

type EnrichedOffer = Offer & Record<string, unknown>;

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function isMeaningfulString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasImage(offer: Offer): boolean {
  return isMeaningfulString(offer.imageUrl);
}

// Honest image-reachability state from the Phase-1 broken-image check (Scan 2.0).
// `missing`   = no URL at all
// `broken`    = URL present but unreachable / not image/* (EDEKA 404 etc.)
// `reachable` = URL reachable AND served as image/*
// `unchecked` = URL present but no Scan-2.0 image probe has run yet
type ImageReachState = 'reachable' | 'broken' | 'unchecked' | 'missing';

function imageReachState(offer: Offer): ImageReachState {
  if (!hasImage(offer)) return 'missing';
  const o = offer as EnrichedOffer;
  const status = typeof o.imageStatus === 'string' ? o.imageStatus.toLowerCase() : '';
  if (o.brokenImage === true || status === 'broken') return 'broken';
  if (status === 'ok' || status === 'reachable') return 'reachable';
  return 'unchecked';
}

function hasValidPrice(offer: Offer): boolean {
  const price = Number(offer.price);
  return Number.isFinite(price) && price > 0;
}

function hasValidTo(offer: Offer): boolean {
  if (!isMeaningfulString(offer.validityEnd)) return false;
  const ms = Date.parse(offer.validityEnd);
  return Number.isFinite(ms);
}

function isCategoryOther(category: string | undefined | null): boolean {
  const normalized = String(category ?? '').trim().toLowerCase();
  return normalized === 'other' || normalized === 'sonstiges';
}

// Fragment-name heuristic lives in offerNameQuality.ts so the REWE import can
// reuse it without pulling the whole quality graph. Re-exported here so existing
// importers (and tests) keep working unchanged.
export { isLikelyFragmentName } from './offerNameQuality';
import { isLikelyFragmentName } from './offerNameQuality';

function isCategoryMissing(category: string | undefined | null): boolean {
  return !isMeaningfulString(category) || isCategoryOther(category);
}

// Risiko-Heuristiken: Begriffe, deren Vorkommen im Namen ein bestimmtes
// Allergen / Alkohol-Risiko stark wahrscheinlich machen. Die Keyword-Listen und
// die Namensprüfung liegen jetzt in dietHeuristics.ts, damit App-Enrichment
// (dealFields.ts) und Admin-Review exakt dieselben Heuristiken nutzen.
const DRINKS_OR_SWEETS_CATEGORIES = new Set([
  'drinks', 'snacks_sweets', 'getraenke', 'snacks_suess',
]);

function isAllergenRisk(offer: Offer): boolean {
  return isAllergenRiskName(offer);
}

function isAlcoholRisk(offer: Offer): boolean {
  const category = String(offer.category ?? '').trim().toLowerCase();
  if (DRINKS_OR_SWEETS_CATEGORIES.has(category)) return true;
  return isAlcoholRiskName(offer);
}

// dietFlags is an opaque payload from the Python pipeline. We expose
// vegetarian/vegan only if the source explicitly answered, never inferred.
function readDietFlag(
  offer: EnrichedOffer,
  key: 'vegetarian' | 'vegan',
): boolean | null {
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

interface PerOfferQuality {
  enrichment: DealEnrichment;
  hasImage: boolean;
  imageReachable: boolean;
  imageBroken: boolean;
  imageChecked: boolean;
  hasCurrentPrice: boolean;
  hasOriginalPrice: boolean;
  hasSavingsPercent: boolean;
  hasNutrition: boolean;
  hasAllergens: boolean;
  halalKnown: boolean;
  alcoholKnown: boolean;
  vegetarianKnown: boolean;
  veganKnown: boolean;
  hasValidTo: boolean;
  withoutCategory: boolean;
}

function evaluateOffer(offer: Offer): PerOfferQuality {
  const enriched = offer as EnrichedOffer;
  const enrichment = deriveDealEnrichment(enriched);
  const reach = imageReachState(offer);
  return {
    enrichment,
    hasImage: hasImage(offer),
    imageReachable: reach === 'reachable',
    imageBroken: reach === 'broken',
    imageChecked: reach === 'reachable' || reach === 'broken',
    hasCurrentPrice: hasValidPrice(offer),
    hasOriginalPrice: enrichment.originalPrice !== null,
    hasSavingsPercent: enrichment.savingsPercent !== null,
    hasNutrition: enrichment.nutrition !== null,
    hasAllergens: enrichment.allergens.length > 0,
    halalKnown: enrichment.isHalal !== null,
    alcoholKnown: enrichment.containsAlcohol !== null,
    vegetarianKnown: readDietFlag(enriched, 'vegetarian') !== null,
    veganKnown: readDietFlag(enriched, 'vegan') !== null,
    hasValidTo: hasValidTo(offer),
    withoutCategory: isCategoryMissing(offer.category),
  };
}

interface StoreAccumulator {
  storeChain: string;
  total: number;
  withImage: number;
  withReachableImage: number;
  brokenImage: number;
  imageChecked: number;
  withCurrentPrice: number;
  withOriginalPrice: number;
  withSavingsPercent: number;
  withNutrition: number;
  withAllergens: number;
  halalKnown: number;
  alcoholKnown: number;
  vegetarianKnown: number;
  veganKnown: number;
  withValidTo: number;
  withoutCategory: number;
}

function emptyAccumulator(storeChain: string): StoreAccumulator {
  return {
    storeChain,
    total: 0,
    withImage: 0,
    withReachableImage: 0,
    brokenImage: 0,
    imageChecked: 0,
    withCurrentPrice: 0,
    withOriginalPrice: 0,
    withSavingsPercent: 0,
    withNutrition: 0,
    withAllergens: 0,
    halalKnown: 0,
    alcoholKnown: 0,
    vegetarianKnown: 0,
    veganKnown: 0,
    withValidTo: 0,
    withoutCategory: 0,
  };
}

function accumulate(acc: StoreAccumulator, q: PerOfferQuality): void {
  acc.total += 1;
  if (q.hasImage) acc.withImage += 1;
  if (q.imageReachable) acc.withReachableImage += 1;
  if (q.imageBroken) acc.brokenImage += 1;
  if (q.imageChecked) acc.imageChecked += 1;
  if (q.hasCurrentPrice) acc.withCurrentPrice += 1;
  if (q.hasOriginalPrice) acc.withOriginalPrice += 1;
  if (q.hasSavingsPercent) acc.withSavingsPercent += 1;
  if (q.hasNutrition) acc.withNutrition += 1;
  if (q.hasAllergens) acc.withAllergens += 1;
  if (q.halalKnown) acc.halalKnown += 1;
  if (q.alcoholKnown) acc.alcoholKnown += 1;
  if (q.vegetarianKnown) acc.vegetarianKnown += 1;
  if (q.veganKnown) acc.veganKnown += 1;
  if (q.hasValidTo) acc.withValidTo += 1;
  if (q.withoutCategory) acc.withoutCategory += 1;
}

// Ehrliche Status-Ableitung pro Store. Echte App-Blocker -> crit; weiche
// Lücken (Bild teilweise, Kategorie teilweise) -> warn; offene Zusatzdaten
// (Nutrition/Halal/Allergene) -> enrichment_pending, NIE crit.
function deriveStoreStatus(s: {
  lowOfferCount: boolean;
  withCurrentPricePercent: number;
  withImagePercent: number;
  withoutCategoryPercent: number;
  withNutritionPercent: number;
  withAllergensPercent: number;
  halalKnownPercent: number;
  // Anteil broken Bilder unter den GEPRÜFTEN Bildern (0, solange nichts geprüft).
  brokenImageOfCheckedPercent: number;
  imageChecked: number;
}): StoreStatus {
  const t = STATUS_THRESHOLDS;
  const critReasons: StoreStatusReason[] = [];
  if (s.lowOfferCount) critReasons.push('low_offers');
  if (s.withCurrentPricePercent < t.currentPriceCrit) critReasons.push('missing_current_price');
  if (s.withImagePercent < t.imageCrit) critReasons.push('missing_images');
  if (s.withoutCategoryPercent >= t.categoryCrit) critReasons.push('uncategorized_high');

  const warnReasons: StoreStatusReason[] = [];
  if (s.withImagePercent >= t.imageCrit && s.withImagePercent < t.imageWarn) {
    warnReasons.push('image_gaps');
  }
  // Nur warnen, wenn der Phase-1-Bildcheck tatsächlich broken Bilder gefunden hat
  // (imageChecked > 0). So bleibt der Status neutral, solange kein Scan-2.0-Check
  // lief — und der EDEKA-404-Fall wird ehrlich als Lücke sichtbar, nicht als 100 %.
  if (s.imageChecked > 0 && s.brokenImageOfCheckedPercent >= t.brokenImageWarn) {
    warnReasons.push('broken_images');
  }
  if (s.withoutCategoryPercent >= t.categoryWarn && s.withoutCategoryPercent < t.categoryCrit) {
    warnReasons.push('uncategorized_some');
  }
  if (
    s.withNutritionPercent < t.enrichmentOpen ||
    s.withAllergensPercent < t.enrichmentOpen ||
    s.halalKnownPercent < t.enrichmentOpen
  ) {
    warnReasons.push('enrichment_pending');
  }

  const tier: StoreStatusTier =
    critReasons.length > 0 ? 'crit' : warnReasons.length > 0 ? 'warn' : 'ok';
  return { tier, reasons: [...critReasons, ...warnReasons] };
}

function finalizeStore(acc: StoreAccumulator): StoreQuality {
  const withImagePercent = percent(acc.withImage, acc.total);
  // Erreichbarkeit relativ zur Gesamtzahl, broken-Anteil relativ zu den geprüften
  // Bildern (so verzerrt ungeprüfter Rest die broken-Quote nicht).
  const withReachableImagePercent = percent(acc.withReachableImage, acc.total);
  const brokenImagePercent = percent(acc.brokenImage, acc.total);
  const brokenImageOfCheckedPercent = percent(acc.brokenImage, acc.imageChecked);
  const withCurrentPricePercent = percent(acc.withCurrentPrice, acc.total);
  const withNutritionPercent = percent(acc.withNutrition, acc.total);
  const withAllergensPercent = percent(acc.withAllergens, acc.total);
  const halalKnownPercent = percent(acc.halalKnown, acc.total);
  const withoutCategoryPercent = percent(acc.withoutCategory, acc.total);
  const lowOfferCount = acc.total > 0 && acc.total < LOW_STORE_OFFERS_THRESHOLD;
  return {
    storeChain: acc.storeChain,
    total: acc.total,
    withImage: acc.withImage,
    withImagePercent,
    withReachableImage: acc.withReachableImage,
    withReachableImagePercent,
    brokenImage: acc.brokenImage,
    brokenImagePercent,
    imageChecked: acc.imageChecked,
    withCurrentPrice: acc.withCurrentPrice,
    withCurrentPricePercent,
    withOriginalPrice: acc.withOriginalPrice,
    withOriginalPricePercent: percent(acc.withOriginalPrice, acc.total),
    withSavingsPercent: acc.withSavingsPercent,
    withSavingsPercentPercent: percent(acc.withSavingsPercent, acc.total),
    withNutrition: acc.withNutrition,
    withNutritionPercent,
    withAllergens: acc.withAllergens,
    withAllergensPercent,
    halalKnown: acc.halalKnown,
    halalKnownPercent,
    alcoholKnown: acc.alcoholKnown,
    alcoholKnownPercent: percent(acc.alcoholKnown, acc.total),
    vegetarianKnown: acc.vegetarianKnown,
    vegetarianKnownPercent: percent(acc.vegetarianKnown, acc.total),
    veganKnown: acc.veganKnown,
    veganKnownPercent: percent(acc.veganKnown, acc.total),
    withValidTo: acc.withValidTo,
    withValidToPercent: percent(acc.withValidTo, acc.total),
    withoutCategory: acc.withoutCategory,
    withoutCategoryPercent,
    lowOfferCount,
    status: deriveStoreStatus({
      lowOfferCount,
      withCurrentPricePercent,
      withImagePercent,
      withoutCategoryPercent,
      withNutritionPercent,
      withAllergensPercent,
      halalKnownPercent,
      brokenImageOfCheckedPercent,
      imageChecked: acc.imageChecked,
    }),
  };
}

function reasonsFor(offer: Offer, q: PerOfferQuality): ReviewReason[] {
  const reasons: ReviewReason[] = [];

  if (!q.hasImage) reasons.push('no_image');
  if (!hasValidPrice(offer)) reasons.push('no_price');

  if (!isMeaningfulString(offer.category)) {
    reasons.push('no_category');
  } else if (isCategoryOther(offer.category)) {
    reasons.push('category_other');
  }

  if (isLikelyFragmentName(offer.name)) reasons.push('name_fragment');

  if (!q.hasNutrition) reasons.push('no_nutrition');
  if (!q.halalKnown) reasons.push('halal_unknown');

  if (isAlcoholRisk(offer) && !q.alcoholKnown) {
    reasons.push('alcohol_unknown_risk');
  }
  if (isAllergenRisk(offer) && !q.hasAllergens) {
    reasons.push('allergens_empty_risk');
  }

  return reasons;
}

function normalizeProcessState(
  raw: Partial<QualityProcessState> | null | undefined,
): QualityProcessState | null {
  if (!raw) return null;
  return {
    running: raw.running === true,
    message: typeof raw.message === 'string' ? raw.message : null,
    stage: typeof raw.stage === 'string' ? raw.stage : null,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
  };
}

/**
 * Build a full quality report for the current snapshot.
 *
 * Pure function: same input -> same output, no IO, no global state.
 */
export function computeQualityReport(input: QualityInput): QualityReport {
  const live = input.offers;

  const storeMap = new Map<string, StoreAccumulator>();
  const review: ReviewItem[] = [];
  const reviewCounts: Record<ReviewReason, number> = {
    no_image: 0,
    no_price: 0,
    no_category: 0,
    category_other: 0,
    no_nutrition: 0,
    halal_unknown: 0,
    alcohol_unknown_risk: 0,
    allergens_empty_risk: 0,
    name_fragment: 0,
  };

  let totalWithImage = 0;
  let totalReachableImage = 0;
  let totalBrokenImage = 0;
  let totalImageChecked = 0;
  let totalWithNutrition = 0;
  let totalHalalKnown = 0;
  let totalWithAllergens = 0;

  const productInfo: ProductInfoSummary = {
    analyzedTotal: 0,
    nutritionVerified: 0,
    nutritionEstimated: 0,
    nutritionUnknown: 0,
    halalKnown: 0,
    halalNotHalal: 0,
    halalDoubtful: 0,
    halalUnknown: 0,
    allergenKnown: 0,
    allergenRisk: 0,
    allergenUnknown: 0,
    alcoholDetected: 0,
    veganCount: 0,
    vegetarianCount: 0,
  };

  for (const offer of live) {
    const q = evaluateOffer(offer);
    const storeChain = isMeaningfulString(offer.storeChain) ? offer.storeChain : 'Unbekannt';
    let acc = storeMap.get(storeChain);
    if (!acc) {
      acc = emptyAccumulator(storeChain);
      storeMap.set(storeChain, acc);
    }
    accumulate(acc, q);

    if (q.hasImage) totalWithImage += 1;
    if (q.imageReachable) totalReachableImage += 1;
    if (q.imageBroken) totalBrokenImage += 1;
    if (q.imageChecked) totalImageChecked += 1;
    if (q.hasNutrition) totalWithNutrition += 1;
    if (q.halalKnown) totalHalalKnown += 1;
    if (q.hasAllergens) totalWithAllergens += 1;

    // Ehrliche Produktinfo-Aggregation aus der geteilten Enrichment-Ableitung.
    const e = q.enrichment;
    if (e.productInfoAnalyzed) productInfo.analyzedTotal += 1;
    if (e.nutritionStatus === 'verified') productInfo.nutritionVerified += 1;
    else if (e.nutritionStatus === 'estimated') productInfo.nutritionEstimated += 1;
    else productInfo.nutritionUnknown += 1;
    if (e.halalStatus === 'halal' || e.halalStatus === 'not_halal') productInfo.halalKnown += 1;
    if (e.halalStatus === 'not_halal') productInfo.halalNotHalal += 1;
    else if (e.halalStatus === 'doubtful') productInfo.halalDoubtful += 1;
    else if (e.halalStatus === 'unknown') productInfo.halalUnknown += 1;
    if (e.allergenStatus === 'known') productInfo.allergenKnown += 1;
    else if (e.allergenStatus === 'risk') productInfo.allergenRisk += 1;
    else productInfo.allergenUnknown += 1;
    if (e.containsAlcohol === true) productInfo.alcoholDetected += 1;
    if (e.isVegan === true) productInfo.veganCount += 1;
    if (e.isVegetarian === true) productInfo.vegetarianCount += 1;

    const reasons = reasonsFor(offer, q);
    if (reasons.length > 0) {
      review.push({
        id: offer.id,
        name: offer.name ?? '',
        storeChain,
        category: offer.category ?? '',
        price: Number.isFinite(Number(offer.price)) ? Number(offer.price) : 0,
        imageUrl: isMeaningfulString(offer.imageUrl) ? offer.imageUrl : null,
        sourceUrl: offer.sourceUrl ?? '',
        reasons,
      });
      for (const reason of reasons) reviewCounts[reason] += 1;
    }
  }

  const stores = [...storeMap.values()]
    .map(finalizeStore)
    .sort((a, b) => b.total - a.total || a.storeChain.localeCompare(b.storeChain, 'de'));

  const liveTotal = live.length;

  return {
    generatedAt: new Date().toISOString(),
    thresholds: {
      lowOfferCount: LOW_STORE_OFFERS_THRESHOLD,
    },
    kpis: {
      liveTotal,
      filteredTotal: input.filteredOffers.length,
      nextWeekTotal: input.nextWeekOffers.length,
      storeCount: stores.length,
      imageCoveragePercent: percent(totalWithImage, liveTotal),
      // Solange noch kein Bildcheck lief (imageCheckedTotal === 0), ist die
      // ehrliche Erreichbarkeitsquote = Bild-Abdeckung; danach zählt nur erreichbar.
      reachableImageCoveragePercent:
        totalImageChecked > 0 ? percent(totalReachableImage, liveTotal) : percent(totalWithImage, liveTotal),
      brokenImageTotal: totalBrokenImage,
      imageCheckedTotal: totalImageChecked,
      nutritionCoveragePercent: percent(totalWithNutrition, liveTotal),
      halalCoveragePercent: percent(totalHalalKnown, liveTotal),
      allergensCoveragePercent: percent(totalWithAllergens, liveTotal),
      updatedAt: input.updatedAt ?? null,
      lastIngest: normalizeProcessState(input.ingest),
      lastAiRun: normalizeProcessState(input.aiRun),
    },
    productInfo,
    stores,
    review,
    reviewCounts,
  };
}
