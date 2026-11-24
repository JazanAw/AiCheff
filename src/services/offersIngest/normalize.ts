import { z } from 'zod';
import { Offer } from '../../types/models';
import { toSimpleOfferCategory } from '../../utils/offerCategory';
import { articleIdForOffer } from '../../utils/articleIdentity';
import { normalizeText, parseDateInput } from '../../utils/offers';
import { RawOfferCandidate } from './types';

const normalizedOfferSchema = z.object({
  articleId: z.string().min(1),
  id: z.string(),
  name: z.string().min(1),
  normalizedName: z.string().min(1),
  brand: z.string().min(1).optional(),
  storeId: z.string().min(1).optional(),
  storeAddress: z.string().min(1).optional(),
  storeCity: z.string().min(1).optional(),
  storeChain: z.string().min(1),
  category: z.string().min(1),
  price: z.number().positive(),
  originalPrice: z.number().positive().optional(),
  currency: z.string().min(1),
  unit: z.string().min(1),
  basePrice: z.number().positive().optional(),
  baseUnit: z.string().min(1).optional(),
  validityStart: z.string(),
  validityEnd: z.string(),
  imageUrl: z.string().url().optional(),
  sourceUrl: z.string().url(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  sourceScope: z.enum(['national', 'local']).optional(),
  distanceKm: z.number().nonnegative().optional(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  // Roh-Quellsignale (Task 2) — optional, damit ältere Quellen unverändert
  // durchlaufen; im Schema enthalten, weil safeParse unbekannte Keys sonst
  // entfernen würde.
  sourceCategoryRaw: z.string().optional(),
  sourceDepartmentRaw: z.string().optional(),
  sourceTagsRaw: z.array(z.string()).optional(),
  sourceContextRaw: z.string().optional(),
  // Subquellen-/Prospekt-Id (Task P5) — optional + additiv.
  sourceId: z.string().optional(),
});

function normalizeCurrency(rawValue: string | undefined): string {
  if (!rawValue || rawValue === '€') {
    return 'EUR';
  }
  return rawValue.toUpperCase();
}

function normalizeUnit(rawUnit?: string): string {
  if (!rawUnit) {
    return 'Stk';
  }
  return rawUnit.replace(/\s+/g, '').toLowerCase();
}

function parseDecimalNumber(value: string | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) ? number : null;
}

function parseIsoDate(rawValue?: string): string | null {
  if (!rawValue) {
    return null;
  }
  return parseDateInput(rawValue);
}

function buildStableId(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }
  return `offer_${Math.abs(hash).toString(36)}`;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }

  const normalized = tags
    .map((tag) => normalizeText(tag))
    .filter((tag) => tag.length > 0);
  return [...new Set(normalized)];
}

function normalizeSingleOffer(raw: RawOfferCandidate): Offer | null {
  const name = raw.name?.trim();
  const storeChain = raw.storeChain?.trim() || 'Unbekannt';
  const category = toSimpleOfferCategory(raw.category, raw.name);
  const sourceUrl = raw.sourceUrl?.trim() || 'https://example.org/unknown';

  if (!name) {
    return null;
  }

  const price = parseDecimalNumber(raw.price);
  if (!price) {
    return null;
  }

  // Only keep an original price that actually represents a discount.
  const parsedOriginalPrice = parseDecimalNumber(raw.originalPrice);
  const originalPrice =
    parsedOriginalPrice !== null && parsedOriginalPrice > price ? parsedOriginalPrice : undefined;

  const validityStart = parseIsoDate(raw.validityStart) ?? new Date().toISOString();
  const validityEnd =
    parseIsoDate(raw.validityEnd) ??
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const normalizedName = normalizeText(name);
  const stableIdSource = `${storeChain}|${normalizedName}|${validityStart}`;

  const candidate: Offer = {
    articleId: articleIdForOffer({
      name,
      normalizedName,
      brand: raw.brand?.trim(),
    }),
    id: raw.id?.trim() || buildStableId(stableIdSource),
    name,
    normalizedName,
    brand: raw.brand?.trim(),
    storeId: raw.storeId?.trim(),
    storeAddress: raw.storeAddress?.trim(),
    storeCity: raw.storeCity?.trim(),
    storeChain,
    category,
    price,
    originalPrice,
    currency: normalizeCurrency(raw.currency),
    unit: normalizeUnit(raw.unit),
    basePrice: parseDecimalNumber(raw.basePrice) ?? undefined,
    baseUnit: raw.baseUnit?.trim(),
    validityStart,
    validityEnd,
    imageUrl: raw.imageUrl?.trim(),
    sourceUrl,
    region: raw.region?.trim(),
    postalCode: raw.postalCode?.trim(),
    latitude: raw.latitude,
    longitude: raw.longitude,
    sourceScope: raw.sourceScope,
    distanceKm: raw.distanceKm,
    tags: normalizeTags(raw.tags),
    createdAt: new Date().toISOString(),
    // Roh-Quellsignale VERBATIM behalten (nicht lowercasen wie `tags`), damit
    // die KI/Klassifikation den ungekürzten Originaltext sieht.
    sourceCategoryRaw: raw.sourceCategoryRaw?.trim() || undefined,
    sourceDepartmentRaw: raw.sourceDepartmentRaw?.trim() || undefined,
    sourceTagsRaw:
      Array.isArray(raw.sourceTagsRaw) && raw.sourceTagsRaw.length > 0
        ? [...raw.sourceTagsRaw]
        : undefined,
    sourceContextRaw: raw.sourceContextRaw?.trim() || undefined,
    sourceId: raw.sourceId?.trim() || undefined,
  };

  const validation = normalizedOfferSchema.safeParse(candidate);
  return validation.success ? validation.data : null;
}

export function normalizeOffers(rawOffers: RawOfferCandidate[]): Offer[] {
  const deduped = new Map<string, Offer>();

  for (const rawOffer of rawOffers) {
    const normalized = normalizeSingleOffer(rawOffer);
    if (!normalized) {
      continue;
    }

    const dedupeKey = `${normalized.storeChain}|${normalized.normalizedName}|${normalized.validityStart}`;
    if (!deduped.has(dedupeKey)) {
      deduped.set(dedupeKey, normalized);
    }
  }

  return [...deduped.values()].sort((left, right) => {
    const byStore = left.storeChain.localeCompare(right.storeChain, 'de');
    if (byStore !== 0) {
      return byStore;
    }
    const byCategory = left.category.localeCompare(right.category, 'de');
    if (byCategory !== 0) {
      return byCategory;
    }
    return left.name.localeCompare(right.name, 'de');
  });
}
