import type { NutritionInfo } from '../types';

/**
 * Result of an Open Food Facts barcode lookup. All fields are best-effort —
 * OFF crowdsources data and a "found" product may have empty name/brand.
 * Callers should treat every field as optional and route to the manual
 * confirm sheet either way.
 */
export interface ProductLookupResult {
  barcode: string;
  productName?: string;
  brand?: string;
  category?: string;
  imageUrl?: string;
  nutrition?: NutritionInfo;
  ingredientsText?: string[];
  rawProductPayload?: unknown;
}

interface OffNutriments {
  'energy-kcal_100g'?: number | string;
  proteins_100g?: number | string;
  carbohydrates_100g?: number | string;
  fat_100g?: number | string;
  sugars_100g?: number | string;
  salt_100g?: number | string;
}

interface OffSelectedImageVariant {
  de?: string;
  en?: string;
  [lang: string]: string | undefined;
}

interface OffSelectedImages {
  front?: { display?: OffSelectedImageVariant };
  [key: string]: { display?: OffSelectedImageVariant } | undefined;
}

interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_de?: string;
  product_name_en?: string;
  generic_name?: string;
  generic_name_de?: string;
  generic_name_en?: string;
  brands?: string;
  categories?: string;
  categories_tags?: string[];
  image_url?: string;
  image_front_url?: string;
  selected_images?: OffSelectedImages;
  nutriments?: OffNutriments;
  ingredients_text?: string;
  ingredients_text_de?: string;
  ingredients_text_en?: string;
  [key: string]: unknown;
}

interface OffResponse {
  status?: number;
  status_verbose?: string;
  code?: string;
  product?: OffProduct;
}

const OFF_BASE_URL = 'https://world.openfoodfacts.org/api/v2/product';
const USER_AGENT = 'Cheffity/1.0 (https://cheffity.app)';
const REQUEST_TIMEOUT_MS = 6000;

function pickLocalizedString(
  product: OffProduct,
  prefix: 'product_name' | 'generic_name' | 'ingredients_text',
  locale: string | undefined,
): string | undefined {
  const lang = (locale ?? '').slice(0, 2).toLowerCase();
  const tryKeys: string[] = [];
  if (lang && lang !== 'de' && lang !== 'en') {
    tryKeys.push(`${prefix}_${lang}`);
  }
  if (lang === 'de') {
    tryKeys.push(`${prefix}_de`);
  }
  if (lang === 'en') {
    tryKeys.push(`${prefix}_en`);
  }
  tryKeys.push(`${prefix}_de`, `${prefix}_en`, prefix);
  for (const key of tryKeys) {
    const value = (product as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseNutriments(nutriments?: OffNutriments): NutritionInfo | undefined {
  if (!nutriments) return undefined;
  const num = (value: number | string | undefined): number | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
  };
  const out: NutritionInfo = {
    calories: num(nutriments['energy-kcal_100g']),
    protein: num(nutriments.proteins_100g),
    carbs: num(nutriments.carbohydrates_100g),
    fat: num(nutriments.fat_100g),
    sugar: num(nutriments.sugars_100g),
    salt: num(nutriments.salt_100g),
  };
  const hasAny = Object.values(out).some((v) => v !== undefined);
  return hasAny ? out : undefined;
}

function parseIngredientsText(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  const parts = text
    .split(/[,;]+/)
    .map((p) => p.replace(/[()\\[\]]/g, '').trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function pickCategory(product: OffProduct): string | undefined {
  const tags = product.categories_tags;
  if (Array.isArray(tags) && tags.length > 0) {
    // Prefer the most-specific (last) human-readable tag. OFF tags look like
    // "en:cocoa-and-its-products" — strip the language prefix for display.
    const last = tags[tags.length - 1];
    if (typeof last === 'string') {
      const stripped = last.includes(':') ? last.split(':').slice(1).join(':') : last;
      const cleaned = stripped.replace(/-/g, ' ').trim();
      if (cleaned.length > 0) return cleaned;
    }
  }
  if (typeof product.categories === 'string' && product.categories.trim().length > 0) {
    // OFF "categories" is a comma-separated string; take the last entry
    // (typically the most specific).
    const parts = product.categories.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return undefined;
}

function pickImageUrl(product: OffProduct, locale: string | undefined): string | undefined {
  const lang = (locale ?? '').slice(0, 2).toLowerCase();
  const display = product.selected_images?.front?.display;
  if (display) {
    if (lang && typeof display[lang] === 'string' && display[lang]) return display[lang];
    if (typeof display.de === 'string' && display.de) return display.de;
    if (typeof display.en === 'string' && display.en) return display.en;
  }
  if (typeof product.image_front_url === 'string' && product.image_front_url.length > 0) {
    return product.image_front_url;
  }
  if (typeof product.image_url === 'string' && product.image_url.length > 0) {
    return product.image_url;
  }
  return undefined;
}

/**
 * Strip the OFF payload down to a small whitelist before persisting. Raw OFF
 * responses are >100 KB which would bloat pantry_items.raw_product_payload.
 */
function buildRawPayload(product: OffProduct): unknown {
  return {
    code: product.code,
    product_name: product.product_name,
    product_name_de: product.product_name_de,
    product_name_en: product.product_name_en,
    brands: product.brands,
    categories: product.categories,
    categories_tags: product.categories_tags,
    selected_images: product.selected_images,
  };
}

function mapOffProduct(
  product: OffProduct,
  barcode: string,
  locale: string | undefined,
): ProductLookupResult {
  const productName =
    pickLocalizedString(product, 'product_name', locale) ??
    pickLocalizedString(product, 'generic_name', locale);
  const brand = typeof product.brands === 'string' && product.brands.trim().length > 0
    ? product.brands.split(',')[0].trim()
    : undefined;
  return {
    barcode,
    productName,
    brand,
    category: pickCategory(product),
    imageUrl: pickImageUrl(product, locale),
    nutrition: parseNutriments(product.nutriments),
    ingredientsText: parseIngredientsText(
      pickLocalizedString(product, 'ingredients_text', locale),
    ),
    rawProductPayload: buildRawPayload(product),
  };
}

/**
 * Fetch a product from Open Food Facts by barcode.
 *
 * - Returns null when OFF reports the product is not found
 *   (HTTP 404 or `status !== 1`). Callers should route the user to the
 *   manual confirm sheet.
 * - Throws on network/timeout/parse failure so callers can show an error.
 *
 * `locale` is a IETF/i18next-style language tag like "de", "en", "tr".
 * Falls back to de → en → unlocalized.
 */
export async function lookupProductByBarcode(
  barcode: string,
  locale?: string,
): Promise<ProductLookupResult | null> {
  const trimmed = barcode.trim();
  if (!trimmed) throw new Error('barcode is required');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${OFF_BASE_URL}/${encodeURIComponent(trimmed)}.json`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Open Food Facts request failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Open Food Facts returned HTTP ${response.status}`);
  }

  let body: OffResponse;
  try {
    body = (await response.json()) as OffResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Open Food Facts returned invalid JSON: ${message}`);
  }

  if (body.status !== 1 || !body.product) return null;
  return mapOffProduct(body.product, trimmed, locale);
}
