import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type {
  AllergenStatus,
  Allergy,
  Deal,
  HalalStatus,
  NutritionInfo,
  NutritionStatus,
  ProductAnalysisSummary,
} from '../types';
import { resolveBackendAssetUrl, trimTrailingSlash } from './backendUrl';
import {
  parseArticleOffersPayload,
  type ArticleOfferLocation,
  type ArticleOffersResult,
} from './articleOffers';
import { resolveDealCategory } from './dealCategory';

export { resolveBackendAssetUrl } from './backendUrl';

interface BackendOffer {
  id: string;
  /** Produktfamilien-Id (article_v3), vom Backend auf jedem Angebot mitgeliefert.
   *  Anders als `id` überlebt sie den Wochenwechsel und ist damit der Anker, mit
   *  dem ein Favorit später wieder ein gültiges Angebot findet. */
  articleId?: string;
  name: string;
  brand?: string;
  storeId?: string;
  storeAddress?: string;
  storeCity?: string;
  storeChain: string;
  category: string;
  price: number;
  currency: string;
  unit: string;
  basePrice?: number;
  baseUnit?: string;
  // Normalized deal fields delivered by the backend serializer (toApiOffer).
  // Each may be null/undefined when the AI enrichment hasn't produced it —
  // the mapper degrades cleanly to undefined, never NaN.
  originalPrice?: number | null;
  oldPrice?: number | null; // legacy alias, still tolerated
  savingsPercent?: number | null;
  savingsAbsolute?: number | null;
  discountPercent?: number | null; // legacy alias
  storeLogoUrl?: string | null;
  validityStart: string;
  validityEnd: string;
  imageUrl?: string;
  sourceUrl: string;
  postalCode?: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  sourceScope?: 'national' | 'local';
  distanceKm?: number;
  tags?: string[];
  ingredients?: string[];
  // Nutrition / dietary metadata (mapped through when present).
  nutrition?: NutritionInfo | null;
  nutritionEstimated?: boolean;
  allergens?: Allergy[] | null;
  isHalal?: boolean | null;
  containsAlcohol?: boolean | null;
  isVegan?: boolean | null;
  isVegetarian?: boolean | null;
  // Derived status summaries (added by the backend dealFields serializer).
  // Optional/tolerant: older or cached payloads may omit them.
  nutritionStatus?: string | null;
  halalStatus?: string | null;
  allergenStatus?: string | null;
  highlight?: 'top' | 'trend' | null;
  trendScore?: number | null;
  // Thin ProductAnalysisV2 projection from the backend dealFields serializer.
  productAnalysis?: ProductAnalysisSummary | null;
  /** Ergebnis der Backend-Kategorisierung (Regeln + KI + Reparaturen). Fuehrend
   *  fuer die Deal-Kategorie — siehe CANONICAL_MAIN_TO_DEAL_CATEGORY. */
  canonicalCategory?: { main?: string; sub?: string } | null;
}

interface BackendOfferScope {
  national?: boolean;
  local?: boolean;
}

interface BackendOffersResponse {
  offers: BackendOffer[];
  nextWeekOffers?: BackendOffer[];
  offerScopes?: Record<string, BackendOfferScope>;
  updatedAt?: string | null;
  warnings?: string[];
}

interface OffersLocationFilter {
  mode: 'none' | 'postalCode' | 'gps';
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  radiusKm: number;
}

/** Re-Export, damit Screens ihre Angebots-Typen aus EINEM Modul ziehen. */
export type { ArticleOfferLocation, ArticleOffersResult };

export interface DealsApiResponse {
  deals: Deal[];
  nextWeekDeals: Deal[];
  updatedAt: string | null;
  warnings: string[];
}

function getExpoHost(): string | null {
  const hostUri = Constants.expoConfig?.hostUri ?? null;
  if (!hostUri) {
    return null;
  }

  return hostUri.split(':')[0] || null;
}

function resolveBackendBaseUrl(): string {
  const configured = trimTrailingSlash(
    process.env.EXPO_PUBLIC_BACKEND_BASE_URL ?? 'http://localhost:8787',
  );

  if (Platform.OS === 'web') {
    return configured;
  }

  try {
    const url = new URL(configured);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const expoHost = getExpoHost();

    if (isLocalhost && expoHost) {
      url.hostname = expoHost;
      return trimTrailingSlash(url.toString());
    }
  } catch {
    return configured;
  }

  return configured;
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 25000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseBackendResponse(payload: unknown): BackendOffersResponse {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { offers?: unknown }).offers)
  ) {
    throw new Error('Backend-Antwort hat kein gueltiges Angebotsformat.');
  }

  const typed = payload as BackendOffersResponse;
  return {
    offers: typed.offers,
    nextWeekOffers: Array.isArray(typed.nextWeekOffers) ? typed.nextWeekOffers : [],
    offerScopes:
      typed.offerScopes && typeof typed.offerScopes === 'object'
        ? typed.offerScopes
        : {},
    updatedAt: typed.updatedAt ?? null,
    warnings: Array.isArray(typed.warnings) ? typed.warnings : [],
  };
}

function getDistanceKm(
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
): number {
  const earthRadiusKm = 6371;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = toRadians(toLatitude - fromLatitude);
  const deltaLon = toRadians(toLongitude - fromLongitude);
  const lat1 = toRadians(fromLatitude);
  const lat2 = toRadians(toLatitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.sin(deltaLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function isOfferNational(
  offer: BackendOffer,
  offerScopes: Record<string, BackendOfferScope>,
): boolean {
  if (offer.sourceScope === 'local' || offer.storeId) {
    return false;
  }
  if (offer.sourceScope === 'national') {
    return true;
  }
  const scope = offerScopes[offer.id];
  if (scope?.local && !scope.national) {
    return false;
  }
  return true;
}

function isOfferMatchingLocation(
  offer: BackendOffer,
  locationFilter: OffersLocationFilter | undefined,
  offerScopes: Record<string, BackendOfferScope>,
): boolean {
  if (!locationFilter || locationFilter.mode === 'none') {
    return true;
  }
  if (isOfferNational(offer, offerScopes)) {
    return true;
  }
  if (
    locationFilter.mode === 'gps' &&
    locationFilter.latitude !== null &&
    locationFilter.longitude !== null &&
    offer.latitude !== undefined &&
    offer.longitude !== undefined
  ) {
    return (
      getDistanceKm(
        locationFilter.latitude,
        locationFilter.longitude,
        offer.latitude,
        offer.longitude,
      ) <= locationFilter.radiusKm
    );
  }
  if (locationFilter.mode === 'postalCode' && locationFilter.postalCode && offer.postalCode) {
    return offer.postalCode.startsWith(locationFilter.postalCode.slice(0, 2));
  }
  return true;
}

/** Finite number or undefined — guards against null/NaN/Infinity from the API. */
function finiteOrUndefined(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** Round to 2 decimals (EUR). Undefined passes through. */
function round2(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 100) / 100;
}

/** Drop NaN/Infinity from a nutrition payload so the UI never renders "NaN". */
function sanitizeNutrition(raw: NutritionInfo | null | undefined): NutritionInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const out: NutritionInfo = {
    calories: finiteOrUndefined(src.calories),
    protein: finiteOrUndefined(src.protein),
    carbs: finiteOrUndefined(src.carbs),
    fat: finiteOrUndefined(src.fat),
    sugar: finiteOrUndefined(src.sugar),
    fiber: finiteOrUndefined(src.fiber),
    salt: finiteOrUndefined(src.salt),
  };
  const hasAny = Object.values(out).some((v) => v !== undefined);
  return hasAny ? out : undefined;
}

// Pure transport passthrough of the backend ProductAnalysisV2 projection. It does
// NOT re-decide vegan/vegetarian/halal/allergen/nutrition — only normalizes the
// shape so the UI can read it safely. undefined when the backend sent none.
function sanitizeProductAnalysis(
  raw: ProductAnalysisSummary | null | undefined,
): ProductAnalysisSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const verdict = (value: unknown): ProductAnalysisSummary['vegan'] => {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    return {
      status: typeof v.status === 'string' ? v.status : 'unknown',
      confidence: typeof v.confidence === 'number' && Number.isFinite(v.confidence) ? v.confidence : null,
      reasonCode: typeof v.reasonCode === 'string' ? v.reasonCode : null,
    };
  };
  const strList = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((x) => String(x)).filter((x) => x.length > 0) : [];
  const allergens = (src.allergens && typeof src.allergens === 'object' ? src.allergens : {}) as Record<string, unknown>;
  const nutrition = (src.nutrition && typeof src.nutrition === 'object' ? src.nutrition : {}) as Record<string, unknown>;
  return {
    version: typeof src.version === 'string' ? src.version : null,
    sourceFingerprint: typeof src.sourceFingerprint === 'string' ? src.sourceFingerprint : null,
    vegan: verdict(src.vegan),
    vegetarian: verdict(src.vegetarian),
    halal: verdict(src.halal),
    reviewNeeded: src.reviewNeeded === true,
    reviewReasons: strList(src.reviewReasons),
    allergens: {
      contains: strList(allergens.contains),
      mayContain: strList(allergens.mayContain),
      freeFrom: strList(allergens.freeFrom),
    },
    nutrition: {
      quality: typeof nutrition.quality === 'string' ? nutrition.quality : null,
      basis: typeof nutrition.basis === 'string' ? nutrition.basis : null,
      plausible: typeof nutrition.plausible === 'boolean' ? nutrition.plausible : null,
    },
    sources: strList(src.sources),
  };
}

// Status resolvers: trust the backend value when it sent a known enum, otherwise
// derive the same honest fallback client-side so the UI still works against an
// older backend or cached payload. They never invent a positive fact.
function resolveNutritionStatus(
  raw: unknown,
  nutrition: NutritionInfo | undefined,
  estimated: boolean,
): NutritionStatus {
  if (raw === 'verified' || raw === 'estimated' || raw === 'unknown') return raw;
  if (!nutrition) return 'unknown';
  return estimated ? 'estimated' : 'verified';
}

function resolveHalalStatus(
  raw: unknown,
  isHalal: boolean | undefined,
  containsAlcohol: boolean | undefined,
): HalalStatus {
  if (raw === 'halal' || raw === 'not_halal' || raw === 'doubtful' || raw === 'unknown') return raw;
  if (isHalal === true) return 'halal';
  if (isHalal === false) return 'not_halal';
  // An alcoholic product is not halal — keep this consistent with the backend
  // dealFields derivation so older/cached payloads resolve the same way.
  if (containsAlcohol === true) return 'not_halal';
  return 'unknown';
}

function resolveAllergenStatus(
  raw: unknown,
  allergens: Allergy[] | undefined,
): AllergenStatus {
  if (raw === 'known' || raw === 'risk' || raw === 'unknown') return raw;
  // The name-based "risk" hint can only come from the backend; client-side we
  // only know "known" (we have an allergen list) vs "unknown".
  if (allergens && allergens.length > 0) return 'known';
  return 'unknown';
}

function mapOfferToDeal(
  offer: BackendOffer,
  offerScopes: Record<string, BackendOfferScope>,
  baseUrl: string,
): Deal {
  const isNational = isOfferNational(offer, offerScopes);
  const currentPrice = round2(finiteOrUndefined(offer.price)) ?? 0;

  // Original price + savings: prefer explicit backend fields, fall back to the
  // legacy aliases (oldPrice/discountPercent), then derive what we can. Only an
  // original price strictly above the current price counts as a real discount.
  const originalPriceRaw = round2(finiteOrUndefined(offer.originalPrice ?? offer.oldPrice));
  const originalPrice =
    originalPriceRaw !== undefined && originalPriceRaw > currentPrice ? originalPriceRaw : undefined;

  let savingsPercent = finiteOrUndefined(offer.savingsPercent ?? offer.discountPercent);
  if (savingsPercent === undefined && originalPrice !== undefined && originalPrice > 0) {
    savingsPercent = Math.round(((originalPrice - currentPrice) / originalPrice) * 100);
  }
  // Clamp to a sane 0–100 range so a bad backend value can't break the badge.
  if (savingsPercent !== undefined) {
    savingsPercent = Math.max(0, Math.min(100, Math.round(savingsPercent)));
  }

  const savingsAbsolute =
    round2(finiteOrUndefined(offer.savingsAbsolute)) ??
    (originalPrice !== undefined ? round2(originalPrice - currentPrice) : undefined);

  const tagList = (offer.tags ?? []).map((tag) => tag.toLowerCase());
  const isHalal = typeof offer.isHalal === 'boolean' ? offer.isHalal : tagList.includes('halal') ? true : undefined;
  const containsAlcohol = typeof offer.containsAlcohol === 'boolean' ? offer.containsAlcohol : undefined;
  const isVegan = typeof offer.isVegan === 'boolean' ? offer.isVegan : undefined;
  const isVegetarian = typeof offer.isVegetarian === 'boolean' ? offer.isVegetarian : undefined;
  const trendScore = finiteOrUndefined(offer.trendScore);
  const allergens = Array.isArray(offer.allergens) && offer.allergens.length > 0 ? offer.allergens : undefined;
  const nutrition = sanitizeNutrition(offer.nutrition);
  const nutritionEstimated = offer.nutritionEstimated === true;
  const ingredients = Array.isArray(offer.ingredients) && offer.ingredients.length > 0 ? offer.ingredients : undefined;

  // Curation hint. Prefer an explicit backend highlight; otherwise derive:
  // strong discounts → "top", aggregate-popularity signals → "trend".
  const isTrendTagged = tagList.some((tag) => /trend|beliebt|popular/.test(tag));
  let highlight: Deal['highlight'] = offer.highlight ?? null;
  if (highlight === null) {
    if (savingsPercent !== undefined && savingsPercent >= 30) {
      highlight = 'top';
    } else if (isTrendTagged || (trendScore !== undefined && trendScore >= 60)) {
      highlight = 'trend';
    }
  }

  return {
    id: offer.id,
    articleId: offer.articleId,
    name: offer.name,
    storeId: offer.storeId,
    storeName: offer.storeChain,
    storeCity: offer.storeCity,
    storeAddress: offer.storeAddress,
    storeLogoUrl: typeof offer.storeLogoUrl === 'string' ? offer.storeLogoUrl : undefined,
    category: resolveDealCategory(offer),
    currentPrice,
    originalPrice,
    savingsPercent,
    savingsAbsolute,
    imageUrl: resolveBackendAssetUrl(offer.imageUrl, baseUrl),
    validFrom: offer.validityStart,
    validTo: offer.validityEnd,
    isNational,
    distanceKm: finiteOrUndefined(offer.distanceKm),
    nutrition,
    nutritionEstimated,
    ingredients,
    allergens,
    isHalal,
    containsAlcohol,
    isVegan,
    isVegetarian,
    nutritionStatus: resolveNutritionStatus(offer.nutritionStatus, nutrition, nutritionEstimated),
    halalStatus: resolveHalalStatus(offer.halalStatus, isHalal, containsAlcohol),
    allergenStatus: resolveAllergenStatus(offer.allergenStatus, allergens),
    highlight,
    trendScore,
    productAnalysis: sanitizeProductAnalysis(offer.productAnalysis),
  };
}

function buildDealsResponse(
  payload: BackendOffersResponse,
  locationFilter?: OffersLocationFilter,
  baseUrl: string = resolveBackendBaseUrl(),
): DealsApiResponse {
  const offerScopes = payload.offerScopes ?? {};
  const offers = payload.offers.filter((offer) =>
    isOfferMatchingLocation(offer, locationFilter, offerScopes),
  );
  const nextWeekOffers = (payload.nextWeekOffers ?? []).filter((offer) =>
    isOfferMatchingLocation(offer, locationFilter, offerScopes),
  );

  return {
    deals: offers.map((offer) => mapOfferToDeal(offer, offerScopes, baseUrl)),
    nextWeekDeals: nextWeekOffers.map((offer) => mapOfferToDeal(offer, offerScopes, baseUrl)),
    updatedAt: payload.updatedAt ?? null,
    warnings: payload.warnings ?? [],
  };
}

export async function fetchDealsFromBackend(
  locationFilter?: OffersLocationFilter,
): Promise<DealsApiResponse> {
  const baseUrl = resolveBackendBaseUrl();
  const response = await fetchWithTimeout(`${baseUrl}/api/offers`);

  if (!response.ok) {
    throw new Error(`Backend-Fehler (${response.status}) beim Laden der Angebote.`);
  }

  const payload = parseBackendResponse((await response.json()) as unknown);
  return buildDealsResponse(payload, locationFilter, baseUrl);
}

// Hier stand refreshDealsFromBackend(), das POST /api/offers/refresh mit
// `tryOllama: true` aufrief und am Pull-to-Refresh der DealsScreen hing.
// Entfernt am 2026-08-04: Die App darf keinen Haendler-Scrape und keinen
// LLM-Lauf ausloesen — das ist globale, teure Verarbeitung ohne Auth und
// ohne Rate-Limit, angestossen von einer beliebig wiederholbaren UI-Geste.
//
// Die App liest ausschliesslich: fetchDealsFromBackend() -> GET /api/offers.
// Ingest laeuft ueber den Weekly-Scheduler im Backend oder manuell ueber
// /admin-v2. Bitte keine schreibende Offer-Route wieder in den Client holen.

/**
 * Loest einen Favoriten auf das aktuell gueltige Angebot auf.
 *
 * Anker ist die wochenstabile `articleId`, NICHT die Angebots-id: Lidl und
 * ALDI NORD vergeben pro Aktionswoche eine neue id fuer dieselbe Ware, ein
 * Favorit von letzter Woche faende sich darueber nie wieder. Das Auswerten
 * liegt in `articleOffers.ts` (RN-frei und dadurch testbar).
 */
export async function fetchArticleOffers(articleId: string): Promise<ArticleOffersResult> {
  const url = `${resolveBackendBaseUrl()}/api/offers/article/${encodeURIComponent(articleId)}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Artikel-Abruf fehlgeschlagen (${response.status})`);
  }
  return parseArticleOffersPayload(await response.json(), articleId);
}

export function getBackendBaseUrlForDebug(): string {
  return resolveBackendBaseUrl();
}
