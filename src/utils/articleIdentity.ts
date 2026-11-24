import type { Offer } from '../types/models';
import { normalizeText } from './offers';

/**
 * Versioned, deterministic product-family identity used by favourites.
 *
 * `Offer.id` identifies one concrete retailer offer. `articleId` deliberately
 * ignores retailer, price, validity and package size, and also removes common
 * flavour/variety descriptors. That lets one favourite match the same product
 * family across stores, weeks and varieties without collapsing the offers
 * themselves.
 */
export const ARTICLE_ID_VERSION = 'article_v3';
export const ARTICLE_ID_PATTERN = /^article_v3_[0-9a-f]{16}$/;

type ArticleIdentityOffer = Pick<Offer, 'name' | 'normalizedName' | 'brand'> &
  Partial<Pick<Offer, 'articleId'>> &
  {
    articleFamily?: unknown;
    productFamily?: unknown;
    productLine?: unknown;
    articleGroup?: unknown;
  };

const VARIETY_BOILERPLATE = new Set([
  'art',
  'auswahl',
  'diverse',
  'edition',
  'geschmack',
  'geschmacksrichtung',
  'mehrere',
  'mit',
  'nach',
  'oder',
  'sorte',
  'sorten',
  'sortiert',
  'versch',
  'verschiedene',
  'verschiedenen',
  'wahl',
  'und',
  'zur',
]);

// Common supermarket varieties. These tokens are removed only when another
// meaningful product token remains, so a standalone "Mango" stays "mango".
const VARIETY_TOKENS = new Set([
  'apfel',
  'banane',
  'barbecue',
  'bbq',
  'beere',
  'brombeere',
  'caramel',
  'classic',
  'erdbeere',
  'funghi',
  'grapefruit',
  'haselnuss',
  'hawaii',
  'heidelbeere',
  'himbeere',
  'kakao',
  'karamell',
  'kirsche',
  'kokos',
  'klassik',
  'lemon',
  'light',
  'limette',
  'mango',
  'maracuja',
  'natur',
  'orange',
  'original',
  'paprika',
  'pfirsich',
  'salami',
  'salame',
  'salz',
  'schoko',
  'spinaci',
  'sweet',
  'tonno',
  'vanille',
  'waldfrucht',
  'zartbitter',
  'zero',
  'zitrone',
  'zuckerfrei',
]);

const PACKAGE_TOKENS = new Set([
  'becher',
  'beutel',
  'dose',
  'flasche',
  'glas',
  'karton',
  'pack',
  'packung',
  'schale',
  'stk',
  'stuck',
  'stueck',
  'tube',
]);

// When a title contains a clear product type, arbitrary trailing names are
// varieties too ("Energy Drink Sea Blue Edition", "Pizza Speciale"). Keep the
// product line through its last type token and drop only what follows it.
const PRODUCT_TYPE_TOKENS = new Set([
  'aufstrich',
  'bonbons',
  'cerealien',
  'chips',
  'cracker',
  'creme',
  'deo',
  'deospray',
  'drink',
  'duschgel',
  'eis',
  'eistee',
  'energydrink',
  'erfrischungsgetraenk',
  'frischkaese',
  'fruchtgummi',
  'hundefutter',
  'joghurt',
  'kaese',
  'kaffee',
  'kapseln',
  'katzenfutter',
  'kekse',
  'limonade',
  'milch',
  'muesli',
  'nektar',
  'pasta',
  'pesto',
  'pizza',
  'pudding',
  'quark',
  'riegel',
  'saft',
  'sauce',
  'shampoo',
  'snack',
  'suppe',
  'tee',
  'waschmittel',
  'weichspueler',
  'zahncreme',
]);

const TOKEN_EXPANSIONS: Readonly<Record<string, readonly string[]>> = {
  energydrink: ['energy', 'drink'],
};

const QUANTITY_TOKEN = /^\d+(?:[.,]\d+)?(?:x\d+(?:[.,]\d+)?)?(?:kg|g|mg|l|ml|cl|dl|er)?$/;
const UNIT_TOKEN = /^(?:kg|g|mg|l|ml|cl|dl)$/;

function normalizedTokens(value: unknown): string[] {
  return normalizeText(String(value ?? ''))
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function startsWithTokens(value: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.every((token, index) => value[index] === token);
}

function explicitFamilyValue(offer: ArticleIdentityOffer): string {
  for (const field of [
    'articleFamily',
    'productFamily',
    'productLine',
    'articleGroup',
  ] as const) {
    const value = offer[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/** Human-readable canonical family key; useful for tests and diagnostics. */
export function articleFamilyKeyForOffer(offer: ArticleIdentityOffer): string {
  const brandTokens = normalizedTokens(offer.brand);
  const explicitFamily = explicitFamilyValue(offer);
  // Prefer the display name so brand and product text are normalized by this
  // one function. Legacy snapshots used both "muller" and "mueller" styles in
  // normalizedName, which would otherwise split the same article family.
  const sourceName = explicitFamily || offer.name || offer.normalizedName;
  let nameTokens = normalizedTokens(sourceName);

  // Some sources expose the brand separately and omit it from the title, while
  // others include it in the title but leave `brand` empty. Canonicalize both to
  // the SAME combined token stream so cross-store favourites still match.
  if (brandTokens.length > 0 && !startsWithTokens(nameTokens, brandTokens)) {
    nameTokens = [...brandTokens, ...nameTokens];
  }

  nameTokens = nameTokens.flatMap((token) => TOKEN_EXPANSIONS[token] ?? [token]);

  const withoutPackaging = nameTokens.filter((token, index, all) => {
    if (PACKAGE_TOKENS.has(token) || UNIT_TOKEN.test(token)) return false;
    if (QUANTITY_TOKEN.test(token)) return false;
    // Handles normalized forms such as "4 x 100 ml".
    if (token === 'x' && index > 0 && index < all.length - 1) return false;
    return true;
  });

  const withoutBoilerplate = withoutPackaging.filter(
    (token) => !VARIETY_BOILERPLATE.has(token),
  );
  const withoutVariety = withoutBoilerplate.filter((token) => !VARIETY_TOKENS.has(token));

  let familyCore = withoutVariety;
  let lastProductType = -1;
  familyCore.forEach((token, index) => {
    if (PRODUCT_TYPE_TOKENS.has(token)) lastProductType = index;
  });
  if (lastProductType >= 0 && lastProductType < familyCore.length - 1) {
    familyCore = familyCore.slice(0, lastProductType + 1);
  }

  // Never erase a real single-word article (e.g. unbranded "Mango"). If every
  // token looked like a variety, branded items collapse to their brand product
  // family while unbranded single articles retain their actual word.
  const familyTokens =
    familyCore.length > 0
      ? familyCore
      : brandTokens.length > 0
        ? ['produkt']
        : withoutBoilerplate.length > 0
        ? withoutBoilerplate
        : nameTokens;

  const family = familyTokens.join(' ') || 'unbekannt';
  return `family:${family}`;
}

/** Two independent 32-bit hashes provide a compact deterministic 64-bit id. */
function stableFamilyHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
    right ^= right >>> 13;
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

export function articleIdForOffer(offer: ArticleIdentityOffer): string {
  return `${ARTICLE_ID_VERSION}_${stableFamilyHash(articleFamilyKeyForOffer(offer))}`;
}

export function isArticleId(value: unknown): value is string {
  return typeof value === 'string' && ARTICLE_ID_PATTERN.test(value);
}

/** Preserve an already-issued v1 id; otherwise add the deterministic id. */
export function withArticleId<T extends Offer>(offer: T): T {
  const current = String(offer.articleId ?? '').trim();
  if (isArticleId(current)) return offer;
  return { ...offer, articleId: articleIdForOffer(offer) };
}

export function withArticleIds<T extends Offer>(offers: readonly T[]): T[] {
  return offers.map(withArticleId);
}

export function offersForArticleId<T extends Offer>(
  offers: readonly T[],
  articleId: string,
): T[] {
  const wanted = articleId.trim();
  if (!wanted) return [];
  return offers.map(withArticleId).filter((offer) => offer.articleId === wanted);
}
