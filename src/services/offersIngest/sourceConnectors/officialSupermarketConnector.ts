import { appConfig } from '../../../config/env';
import { LocationFilter } from '../../../types/models';
import { classifyOfferBucket } from '../../../utils/offerBucket';
import { toSimpleOfferCategory } from '../../../utils/offerCategory';
import { normalizeText } from '../../../utils/offers';
import {
  RawOfferCandidate,
  RawSourceDocument,
  SourceConnector,
  SourceConnectorRuntime,
} from '../types';
import {
  buildSubSourceDiagnostic,
  type SubSourceDiagnostic,
} from '../subSourceDiagnostics';
import {
  NAHKAUF_LOCAL_OFFER_TAG,
  resolveStoreImportStrategy,
  type ImportStrategy,
} from './storeImportStrategy';
import {
  createDefaultLidlOcrPair,
  createDefaultPriceCropOcr,
  createLidlOcrEvidenceWriter,
  defaultLidlOcrImage,
  runLidlProspectOcr,
  type LidlOcrEvidenceWriter,
  type LidlOcrMode,
  type LidlOcrPageEvidence,
  type OcrLayoutPage,
  type PriceCropOcr,
  type RunLidlProspectOcrResult,
} from './lidlProspectOcr';
import {
  createDefaultLidlVisionAdapter,
  createDefaultLidlVisionImageTiler,
  createLidlVisionEvidenceWriter,
  runLidlVisionProspectImport,
  type AnalyzeLidlProspectImage,
  type LidlVisionEvidenceWriter,
  type LidlVisionImageTiler,
  type LidlVisionPageEvidence,
  type RunLidlVisionImportResult,
  type VisionTileImage,
} from './lidlVisionProspectImport';

type OfficialParser =
  | 'aldi'
  | 'aldiNord'
  | 'edeka'
  | 'hit'
  | 'kaufland'
  | 'lidl'
  | 'nahkauf'
  | 'netto'
  | 'norma'
  | 'penny'
  | 'generic';

export interface OfficialStoreConfig {
  storeChain: string;
  url: string;
  parser: OfficialParser;
  /** Explicit, machine-readable import strategy (Task 1). Stamped from the
   *  shared {@link resolveStoreImportStrategy} so REWE/nahkauf are visibly
   *  `browser_required`, never a normal fetch-only shop. Optional so hand-built
   *  configs (tests) need not repeat it; the canonical `officialStores` list
   *  always stamps it. */
  strategy?: ImportStrategy;
}

interface CacheEntry {
  key: string;
  offers: RawOfferCandidate[];
  warnings: string[];
  subSourceDiagnostics: SubSourceDiagnostic[];
  createdAt: number;
}

/** YYYYMMDD (z. B. 20260615) → ISO-Tagesbeginn (UTC), für die erwartete
 *  Gültigkeit eines Lidl-Wochenprospekts. */
function ymdToIsoStart(ymd: number | null): string | undefined {
  if (ymd === null) return undefined;
  const s = String(ymd);
  if (s.length !== 8) return undefined;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00.000Z`;
}

/** Erwartetes Prospektende = Start + 6 Tage (Lidl-Wochenprospekt). */
function isoPlusDays(iso: string | undefined, days: number): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t + days * 24 * 60 * 60 * 1000).toISOString();
}

interface PennyCategoryRef {
  week: string;
  categoryName: string;
  categoryType: string;
}

interface PennyOfferTile {
  title?: unknown;
  type?: unknown;
  quantity?: unknown;
  price?: unknown;
  listPrice?: unknown;
  originalPrice?: unknown;
  crossOutPrice?: unknown;
  basePrice?: unknown;
  benefitPrice?: unknown;
  imageRendition?: {
    tileMd?: unknown;
    tileLg?: unknown;
    tileXl?: unknown;
    imageAlt?: unknown;
    imageTitle?: unknown;
  };
  linkHref?: unknown;
  detailLinkHref?: unknown;
  uuid?: unknown;
  productData?: unknown;
  primaryType?: unknown;
}

interface HitArticle {
  id?: unknown;
  headline?: unknown;
  overview?: unknown;
  price?: unknown;
  recommendedPrice?: unknown;
  url?: unknown;
  image?: {
    mobile?: unknown;
    tablet?: unknown;
    desktop?: unknown;
  };
  priceTag?: {
    basePriceText?: unknown;
    appBasePriceText?: unknown;
    priceStrikeThroughText?: unknown;
    offerCount?: unknown;
  };
  labels?: unknown;
}

interface LidlLeafletProduct {
  productId?: unknown;
  title?: unknown;
  brand?: unknown;
  price?: unknown;
  currencySymbol?: unknown;
  image?: unknown;
  url?: unknown;
  canonicalUrl?: unknown;
  wonCategoryPrimary?: unknown;
  categoryPrimary?: unknown;
  description?: unknown;
}

interface NahkaufStory {
  uuid?: unknown;
  full_slug?: unknown;
  content?: unknown;
}

interface NahkaufOfferContent {
  advertising_product_name?: unknown;
  brand?: unknown;
  promotion_price?: unknown;
  cross_out_price?: unknown;
  amount?: unknown;
  base_price?: unknown;
  images?: unknown;
  features?: unknown;
  valid_from?: unknown;
  valid_to?: unknown;
  national_all?: unknown;
  market_ids?: unknown;
  market_ids_array?: unknown;
  offer_id?: unknown;
}

// Strategy is stamped from the shared resolver (single source of truth) so the
// store config and the per-store health report can never disagree.
const officialStores: OfficialStoreConfig[] = (
  [
    { storeChain: 'Lidl', url: 'https://www.lidl.de/c/online-prospekte/s10005610', parser: 'lidl' },
    // ALDI SÜD: strukturierter Website-Connector über die zentrale Wochenangebote-
    // Sammelseite mit Pagination (__NUXT_DATA__ + DOM-Kacheln, HTTP 200 — kein
    // 403/Anti-Bot-Bypass, kein PDF/Vision). Die store.url bleibt /angebote als
    // Referer/Identität; die echte Quelle ist ALDI_SUED_COLLECTION_SOURCE.
    { storeChain: 'ALDI SUED', url: 'https://www.aldi-sued.de/angebote', parser: 'aldi' },
    { storeChain: 'ALDI NORD', url: 'https://www.aldi-nord.de/angebote.html', parser: 'aldiNord' },
    { storeChain: 'REWE', url: 'https://www.rewe.de/angebote', parser: 'generic' },
    { storeChain: 'nahkauf', url: 'https://www.nahkauf.de/angebote-im-markt/', parser: 'nahkauf' },
    { storeChain: 'EDEKA', url: 'https://www.edeka.de/angebote', parser: 'edeka' },
    { storeChain: 'PENNY', url: 'https://www.penny.de/angebote', parser: 'penny' },
    {
      storeChain: 'Netto',
      url: 'https://www.netto-online.de/online-wochenangebote/c-N0794',
      parser: 'netto',
    },
    {
      storeChain: 'Kaufland',
      url: 'https://filiale.kaufland.de/angebote/aktuelle-woche.html',
      parser: 'kaufland',
    },
    { storeChain: 'HIT', url: 'https://www.hit.de/angebote', parser: 'hit' },
    { storeChain: 'NORMA', url: 'https://www.norma-online.de/de/angebote/', parser: 'norma' },
  ] satisfies Omit<OfficialStoreConfig, 'strategy'>[]
).map((store) => ({
  ...store,
  strategy: resolveStoreImportStrategy(store.storeChain).strategy,
}));

/**
 * The official supermarket stores to scrape, minus any excluded chains
 * (case-insensitive). The weekly auto-scan excludes REWE/nahkauf — they
 * 403/captcha and stay Screenshot/PDF import only. Pure + exported so the
 * exclusion is unit-testable without hitting the network.
 */
export function selectOfficialStores(
  excludeStoreChains: readonly string[] = [],
): OfficialStoreConfig[] {
  const excluded = new Set(
    excludeStoreChains
      .map((chain) => String(chain).trim().toLowerCase())
      .filter((chain) => chain.length > 0),
  );
  if (excluded.size === 0) {
    return [...officialStores];
  }
  return officialStores.filter(
    (store) => !excluded.has(store.storeChain.trim().toLowerCase()),
  );
}

let cacheEntry: CacheEntry | null = null;
let lastRequestAt = 0;

/** Setzt den modulweiten Scrape-Cache zurück (nur für Tests, damit ein Lauf nicht
 *  still den Cache eines anderen Tests trifft). */
function resetOfficialOffersCacheForTests(): void {
  cacheEntry = null;
  lastRequestAt = 0;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForRateLimit(): Promise<void> {
  const minDelayMs = Math.max(750, appConfig.ingestRateLimitMs);
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < minDelayMs) {
    await wait(minDelayMs - elapsed);
  }
  lastRequestAt = Date.now();
}

function decodeHtml(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    euro: '\u20ac',
    uuml: '\u00fc',
    Uuml: '\u00dc',
    ouml: '\u00f6',
    Ouml: '\u00d6',
    auml: '\u00e4',
    Auml: '\u00c4',
    szlig: '\u00df',
  };

  return value
    .replace(/&([a-zA-Z]+);/g, (match, entity: string) => namedEntities[entity] ?? match)
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, ' '))
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getAttribute(html: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`${escapedName}=["']([^"']+)["']`, 'i'));
  return match ? decodeHtml(match[1]).trim() : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseDecimal(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const cleaned = value.replace(/[^\d,.-]/g, '').replace(/^-([,.])/, '0$1');
  if (!cleaned) {
    return undefined;
  }

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(2)) : undefined;
}

function parseDateTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const trimmed = value.trim();
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const candidate =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)
      ? `${trimmed}:00${hasTimezone ? '' : 'Z'}`
      : hasTimezone
        ? trimmed
        : `${trimmed}Z`;
  const parsed = new Date(candidate);

  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

function resolveUrl(url: string | undefined, baseUrl: string): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    return new URL(decodeHtml(url), baseUrl).toString();
  } catch {
    return undefined;
  }
}

function normalizeUnit(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = stripHtml(value)
    .replace(/^je\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || undefined;
}

function inferUnit(name: string, fallback?: string): string {
  const normalizedFallback = normalizeUnit(fallback);
  if (normalizedFallback) {
    return normalizedFallback;
  }

  const match = name.match(
    /(\d+(?:[,.]\d+)?)\s*(kg|g|l|ml|cl|stk|st|stueck|\u00fcck)\b/i,
  );
  if (!match) {
    return 'Stk';
  }

  const unit = match[2].toLowerCase().replace('stueck', 'stk').replace('\u00fcck', 'stk');
  return `${match[1].replace(',', '.')}${unit}`;
}

function defaultValidity(): { start: string; end: string } {
  const start = new Date();
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function dateOnlyToIso(
  value: string | undefined,
  endOfDay = false,
): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return parseDateTime(value);
  }

  return `${match[1]}-${match[2]}-${match[3]}T${
    endOfDay ? '23:59:59.999' : '00:00:00.000'
  }Z`;
}

function secondsToIso(value: unknown, endOfDay = false): string | undefined {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number) || number <= 0) {
    return undefined;
  }

  const date = new Date(number * 1000);
  if (endOfDay) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date.toISOString();
}

function addDaysIso(value: string, days: number, endOfDay = false): string {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  if (endOfDay) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date.toISOString();
}

function validityForIsoWeek(weekToken: string): { start: string; end: string } | undefined {
  const match = weekToken.match(/^(\d{4})-(\d{1,2})$/);
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(week) || week < 1 || week > 53) {
    return undefined;
  }

  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const weekOneMonday = new Date(jan4);
  weekOneMonday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);

  const start = new Date(weekOneMonday);
  start.setUTCDate(weekOneMonday.getUTCDate() + (week - 1) * 7);

  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function stableOfficialId(storeChain: string, name: string, sourceUrl: string): string {
  const source = `${storeChain}|${normalizeText(name)}|${sourceUrl}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash << 5) - hash + source.charCodeAt(index);
    hash |= 0;
  }
  return `official_${Math.abs(hash).toString(36)}`;
}

function parseBasePriceText(
  value: string | undefined,
): { basePrice?: number; baseUnit?: string } {
  const text = stripHtml(value ?? '').replace(/[()]/g, '').trim();
  if (!text) {
    return {};
  }

  const equalsMatch = text.match(
    /^(.+?)\s*=\s*(?:\u20ac|EUR)?\s*([\d.,-]+)\s*(?:\u20ac|EUR)?/i,
  );
  if (equalsMatch) {
    return {
      basePrice: parseDecimal(equalsMatch[2]),
      baseUnit: equalsMatch[1].trim(),
    };
  }

  const slashMatch = text.match(/([\d.,-]+)\s*(?:\u20ac|EUR)?\s*\/\s*(.+)$/i);
  if (slashMatch) {
    return {
      basePrice: parseDecimal(slashMatch[1]),
      baseUnit: slashMatch[2].trim(),
    };
  }

  return {};
}

function parseHtmlJsonAttribute(value: string): unknown | null {
  try {
    return JSON.parse(decodeHtml(value)) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberText(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : textValue(value);
}

function containsNormalized(source: string, keywords: string[]): boolean {
  return keywords.some((keyword) => source.includes(keyword));
}

function dedupeOffersById(offers: RawOfferCandidate[]): RawOfferCandidate[] {
  const byId = new Map<string, RawOfferCandidate>();
  for (const offer of offers) {
    if (offer.id) {
      byId.set(offer.id, offer);
    }
  }
  return [...byId.values()];
}

function parseJsonStringLiteral(value: string): string | undefined {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return undefined;
  }
}

function collectRecordsWithKey(
  value: unknown,
  key: string,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectRecordsWithKey(entry, key, out));
    return out;
  }

  if (!isRecord(value)) {
    return out;
  }

  if (key in value) {
    out.push(value);
  }

  for (const child of Object.values(value)) {
    collectRecordsWithKey(child, key, out);
  }

  return out;
}

function buildCandidate(input: {
  storeChain: string;
  name: string;
  brand?: string;
  price?: number;
  originalPrice?: number;
  unit?: string;
  basePrice?: number;
  baseUnit?: string;
  imageUrl?: string;
  sourceUrl: string;
  category?: string;
  validityStart?: string;
  validityEnd?: string;
  tags?: string[];
  sourceScope?: 'national' | 'local';
}): RawOfferCandidate | null {
  const name = stripHtml(input.name).replace(/\*+$/g, '').trim();
  if (!name || !input.price) {
    return null;
  }

  const defaultDates = defaultValidity();
  // Keep the RAW source category verbatim BEFORE collapsing it to the simple
  // taxonomy (Task 2), so the KI/classification (e.g. international foods) still
  // sees "Molkereiprodukte"/"Internationale Kühlung" — never just "Sonstiges".
  const sourceCategoryRaw = (input.category ?? '').trim() || undefined;
  const category = toSimpleOfferCategory(input.category ?? 'Sonstiges', name);
  const tags = [...(input.tags ?? [])];
  const hasDiscount = Boolean(input.originalPrice && input.originalPrice > input.price);
  if (hasDiscount) {
    tags.push('reduziert');
  }

  return {
    id: stableOfficialId(input.storeChain, name, input.sourceUrl),
    name,
    brand: input.brand ? stripHtml(input.brand) : undefined,
    storeChain: input.storeChain,
    category,
    price: input.price,
    // Preserve the struck-through original price so savings can be shown.
    originalPrice: hasDiscount ? input.originalPrice : undefined,
    currency: 'EUR',
    unit: inferUnit(name, input.unit),
    basePrice: input.basePrice,
    baseUnit: input.baseUnit,
    validityStart: input.validityStart ?? defaultDates.start,
    validityEnd: input.validityEnd ?? defaultDates.end,
    imageUrl: input.imageUrl,
    sourceUrl: input.sourceUrl,
    sourceScope: input.sourceScope,
    tags: [...new Set(tags)],
    // Roh-Quellsignale (Task 2) — additiv, brechen keine bestehenden Felder.
    sourceCategoryRaw,
    sourceTagsRaw: input.tags && input.tags.length > 0 ? [...input.tags] : undefined,
  };
}

function aldiSuedValidityFromUrl(
  url: string,
): { validityStart?: string; validityEnd?: string; category?: string } {
  const date = url.match(/\/angebote\/(\d{4}-\d{2}-\d{2})/)?.[1];
  let category: string | undefined;

  try {
    const theme = new URL(url).searchParams.get('theme');
    category = theme ? decodeHtml(theme).trim() : undefined;
  } catch {
    category = undefined;
  }

  return {
    validityStart: dateOnlyToIso(date),
    validityEnd: date ? addDaysIso(date, 6, true) : undefined,
    category,
  };
}

function parseAldiProductTiles(
  html: string,
  store: OfficialStoreConfig,
): RawOfferCandidate[] {
  const offers: RawOfferCandidate[] = [];
  const pageMeta = aldiSuedValidityFromUrl(store.url);
  const marker = 'id="product-tile-';
  let cursor = html.indexOf(marker);

  while (cursor >= 0) {
    const next = html.indexOf(marker, cursor + marker.length);
    const block = html.slice(cursor, next >= 0 ? next : undefined);

    const title = getAttribute(block, 'title');
    const href = getAttribute(block, 'href');
    const imageUrl = resolveUrl(getAttribute(block, 'src'), store.url);
    const brandMatch = block.match(/product-tile__brandname[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    const unitMatch = block.match(/product-tile__unit-of-measurement[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    const baseMatch = block.match(/product-tile__comparison-price[\s\S]*?<p[^>]*>\(([\s\S]*?)\)<\/p>/i);
    const priceLabel = block.match(
      /(?:Reduzierter Preis|Preis):\s*([\d.,]+)\s*(?:\u20ac|EUR)/i,
    );
    const priceText =
      priceLabel?.[1] ??
      block.match(/base-price__discounted[^>]*>([\d.,]+)\s*(?:\u20ac|EUR)/i)?.[1] ??
      block.match(/base-price__regular[\s\S]*?>([\d.,]+)\s*(?:\u20ac|EUR)/i)?.[1];
    const originalPriceText =
      block.match(/Originalpreis:\s*([\d.,]+)\s*(?:\u20ac|EUR)/i)?.[1] ??
      block.match(/<del[^>]*>([\d.,]+)\s*(?:\u20ac|EUR)<\/del>/i)?.[1];
    const baseParts = parseBasePriceText(baseMatch?.[1]);

    const candidate = buildCandidate({
      storeChain: store.storeChain,
      name: title ?? '',
      brand: stripHtml(brandMatch?.[1] ?? '') || undefined,
      price: parseDecimal(priceText),
      originalPrice: parseDecimal(originalPriceText),
      unit: stripHtml(unitMatch?.[1] ?? ''),
      basePrice: baseParts.basePrice,
      baseUnit: baseParts.baseUnit,
      imageUrl,
      sourceUrl: resolveUrl(href, store.url) ?? store.url,
      category: pageMeta.category,
      validityStart: pageMeta.validityStart,
      validityEnd: pageMeta.validityEnd,
    });

    if (candidate) {
      offers.push(candidate);
    }

    cursor = next;
  }

  return offers;
}

const aldiSuedOfferThemeKeywords = [
  'aktionen',
  'frische',
  'gekuhlte',
  'gekuehlte',
  'internationale',
  'markenartikel',
  'tiefkuhl',
  'grillen',
];

function extractAldiSuedOfferPageUrls(
  html: string,
  store: OfficialStoreConfig,
): string[] {
  const urls = new Set<string>();
  const hrefs = html.matchAll(/href=["']([^"']*\/angebote\/\d{4}-\d{2}-\d{2}[^"']*)["']/gi);

  for (const hrefMatch of hrefs) {
    const url = resolveUrl(hrefMatch[1], store.url);
    if (!url) {
      continue;
    }

    try {
      const parsed = new URL(url);
      const theme = parsed.searchParams.get('theme');
      const normalizedTheme = normalizeText(theme ? decodeHtml(theme) : '');
      if (!theme || containsNormalized(normalizedTheme, aldiSuedOfferThemeKeywords)) {
        urls.add(parsed.toString());
      }
    } catch {
      // Ignore malformed offer links.
    }
  }

  return [...urls].slice(0, 24);
}

// ── ALDI NORD: strukturierter Website-Connector ─────────────────────────────
// ALDI NORD liefert die Wochenangebote strukturiert im öffentlichen HTML: im
// __NEXT_DATA__-Script bzw. in den self.__next_f-Chunks steckt `apiData` mit dem
// OFFER_GET-Payload (res.algoliaDataMap = Produkt-Map, plus Angebotsbereiche mit
// productIds wie "Aktion Mo. 22.6." / "Aktion Do. 25.6."). KEIN Login, kein PDF/
// OCR/Vision — nur die regulär ausgelieferte Seite. Der Datumsbezug kommt IMMER
// aus validFromLocalDate/validUntilLocalDate (keine KW-Hardcodes).

const ALDI_NORD_STRUCTURED_TAG = 'aldi-nord-structured';
const ALDI_NORD_EXAMPLE_CAP = 8;

export interface AldiNordImportDiagnostics {
  generatedAt: string;
  sourceUrl: string;
  /** Wurde apiData (escaptes JSON-String ODER __NEXT_DATA__) im HTML gefunden? */
  apiDataFound: boolean;
  /** Quelle blockiert / Fetch fehlgeschlagen (kein HTML/apiData erreichbar). */
  blocked: boolean;
  blockReason?: string;
  httpStatus?: number;
  // ── Zählkette: Struktur → Preis → Gültigkeit → Bild → current/future ───────
  /** Produkte in algoliaDataMap (vor jeder Filterung). */
  structuredProductsFound: number;
  productsWithPrice: number;
  productsWithValidity: number;
  productsWithImage: number;
  /** Importierte Angebote, deren Gültigkeit erst künftig beginnt (upcoming). */
  futureProducts: number;
  /** Importierte Angebote, die heute aktiv sind (oder ohne Datum sichtbar). */
  currentProducts: number;
  importedDistinct: number;
  duplicatesMerged: number;
  /** Angebotsbereiche (Aktionsflächen) mit productIds. */
  areaCount: number;
  // ── Beispiele bei fehlendem Preis/Datum/Bild (nie riesige Listen) ──────────
  missingPriceExamples: string[];
  missingValidityExamples: string[];
  missingImageExamples: string[];
  /** Zeitpunkt des letzten Laufs in diesem Prozess mit ≥1 Angebot. */
  lastSuccessfulAt?: string;
}

/** Marke + Name, sofern die Marke nicht bereits (umlaut-/case-tolerant) im Namen
 *  steckt — z. B. "Red Bull" + "Energy Drink" → "Red Bull Energy Drink", aber
 *  "LANDFREUDE Gabelspaghetti" bleibt unverdoppelt. */
function composeAldiNordName(name: string, brand: string | undefined): string {
  const cleanName = stripHtml(name).trim();
  const cleanBrand = brand ? stripHtml(brand).trim() : '';
  if (!cleanBrand || !cleanName) {
    return cleanName;
  }
  const normalizedName = normalizeText(cleanName);
  const normalizedBrand = normalizeText(cleanBrand);
  if (normalizedBrand && normalizedName.includes(normalizedBrand)) {
    return cleanName;
  }
  return `${cleanBrand} ${cleanName}`.trim();
}

interface AldiNordArea {
  title: string;
  validFrom?: string;
  validUntil?: string;
  productIds: string[];
}

interface AldiNordAreaRef {
  title: string;
  validFrom?: string;
  validUntil?: string;
}

const ALDI_NORD_AREA_TITLE_KEYS = [
  'name',
  'title',
  'headline',
  'label',
  'teaserTitle',
  'categoryName',
  'displayName',
];

function aldiNordAreaTitle(record: Record<string, unknown>): string | undefined {
  for (const key of ALDI_NORD_AREA_TITLE_KEYS) {
    const value = textValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function aldiNordProductIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    const id = numberText(entry) ?? textValue(entry);
    if (id) ids.push(id);
  }
  return ids;
}

/** Angebotsbereiche (Aktionsflächen) shape-tolerant sammeln: jeder Record mit
 *  einem productIds-Array UND einem Titel ist ein Bereich. Generisch — keine
 *  Marken-/Produkt-/KW-Hardcodes. */
function collectAldiNordAreas(apiData: unknown): AldiNordArea[] {
  const areas: AldiNordArea[] = [];
  for (const key of ['productIds', 'productIDs', 'articleIds', 'productIdList']) {
    for (const record of collectRecordsWithKey(apiData, key)) {
      const productIds = aldiNordProductIds(record[key]);
      if (productIds.length === 0) continue;
      const title = aldiNordAreaTitle(record);
      if (!title) continue;
      areas.push({
        title,
        validFrom: textValue(record.validFromLocalDate),
        validUntil: textValue(record.validUntilLocalDate),
        productIds,
      });
    }
  }
  return areas;
}

/** objectID → Bereiche, in denen das Produkt vorkommt (für Bereich-Erhalt beim
 *  Dedupe + Validity-Fallback). */
function buildAldiNordAreaIndex(areas: AldiNordArea[]): Map<string, AldiNordAreaRef[]> {
  const index = new Map<string, AldiNordAreaRef[]>();
  for (const area of areas) {
    const ref: AldiNordAreaRef = {
      title: area.title,
      validFrom: area.validFrom,
      validUntil: area.validUntil,
    };
    for (const id of area.productIds) {
      const list = index.get(id) ?? [];
      list.push(ref);
      index.set(id, list);
    }
  }
  return index;
}

/** Alle algoliaDataMap-Produkte aus dem apiData-Baum (mehrere OFFER_GET-Tupel
 *  werden zusammengeführt). */
function collectAldiNordProducts(apiData: unknown): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = [];
  for (const record of collectRecordsWithKey(apiData, 'algoliaDataMap')) {
    const map = record.algoliaDataMap;
    if (!isRecord(map)) continue;
    for (const product of Object.values(map)) {
      if (isRecord(product)) products.push(product);
    }
  }
  return products;
}

/** apiData entweder aus dem escapten JSON-String ("apiData":"…") ODER aus dem
 *  __NEXT_DATA__-Script lesen — beide tragen denselben OFFER_GET-Payload. */
function extractAldiNordApiData(html: string): unknown | null {
  const apiDataMatch = html.match(/"apiData":"((?:\\.|[^"\\])*)"/);
  if (apiDataMatch) {
    const text = parseJsonStringLiteral(apiDataMatch[1]);
    if (text) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        /* fällt auf __NEXT_DATA__ zurück */
      }
    }
  }
  const nextDataMatch = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextDataMatch) {
    try {
      const parsed = JSON.parse(nextDataMatch[1]) as unknown;
      return resolveAldiNordApiDataValue(parsed);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Im __NEXT_DATA__-Baum den apiData-Wert finden (String → JSON.parse, sonst der
 *  bereits geparste Wert). */
function resolveAldiNordApiDataValue(parsed: unknown): unknown | null {
  for (const record of collectRecordsWithKey(parsed, 'apiData')) {
    const apiData = record.apiData;
    if (typeof apiData === 'string') {
      try {
        return JSON.parse(apiData) as unknown;
      } catch {
        continue;
      }
    }
    if (apiData && typeof apiData === 'object') {
      return apiData;
    }
  }
  return null;
}

interface AldiNordProductParse {
  candidate: RawOfferCandidate | null;
  objectId?: string;
  name: string;
  hadPrice: boolean;
  hadValidity: boolean;
  hadImage: boolean;
}

function parseAldiNordProduct(
  value: Record<string, unknown>,
  store: OfficialStoreConfig,
  areaIndex: Map<string, AldiNordAreaRef[]>,
): AldiNordProductParse {
  const objectId = textValue(value.objectID);
  const areas = objectId ? areaIndex.get(objectId) ?? [] : [];
  const displayName = composeAldiNordName(textValue(value.name) ?? '', textValue(value.brandName));

  const price = isRecord(value.currentPrice) ? value.currentPrice : {};
  const promotionPrices = Array.isArray(value.promotionPrices) ? value.promotionPrices : [];
  const firstPromotion = isRecord(promotionPrices[0]) ? promotionPrices[0] : {};
  const currentStrike = isRecord(price.strikePrice) ? price.strikePrice : {};
  const promoStrike = isRecord(firstPromotion.strikePrice) ? firstPromotion.strikePrice : {};
  const basePriceSource = Array.isArray(price.basePrice)
    ? price.basePrice.find(isRecord)
    : Array.isArray(firstPromotion.basePrice)
      ? firstPromotion.basePrice.find(isRecord)
      : undefined;
  const assets = Array.isArray(value.assets) ? value.assets.filter(isRecord) : [];
  const primaryAsset = assets.find((asset) => textValue(asset.type) === 'primary') ?? assets[0];

  const priceValue =
    parseDecimal(numberText(price.priceValue)) ??
    parseDecimal(numberText(firstPromotion.priceValue));

  // Validity: validFromLocalDate/validUntilLocalDate aus promotionPrices/currentPrice
  // bevorzugt, dann die Bereichsdaten, zuletzt die epoch-Sekunden.
  const validityStart =
    dateOnlyToIso(
      textValue(firstPromotion.validFromLocalDate) ?? textValue(price.validFromLocalDate),
    ) ??
    dateOnlyToIso(areas.find((area) => area.validFrom)?.validFrom) ??
    secondsToIso(price.validFrom ?? firstPromotion.validFrom);
  const validityEnd =
    dateOnlyToIso(
      textValue(firstPromotion.validUntilLocalDate) ?? textValue(price.validUntilLocalDate),
      true,
    ) ??
    dateOnlyToIso(areas.find((area) => area.validUntil)?.validUntil, true) ??
    secondsToIso(price.validUntil ?? firstPromotion.validUntil, true);

  const imageUrl = resolveUrl(textValue(primaryAsset?.url), store.url);
  const slug = textValue(value.productSlug);
  const sourcePath = slug
    ? `/produkt/${slug}.html`
    : objectId
      ? `/angebote/${objectId}.html`
      : '/angebote.html';

  // Bereich(e) als Roh-Quellkategorie behalten; mainCategoryID als Fallback.
  const areaTitles = [...new Set(areas.map((area) => area.title).filter(Boolean))];
  const category =
    areaTitles.length > 0
      ? areaTitles.join(' · ')
      : textValue(value.mainCategoryID) ?? 'Angebote';

  // Pfand NICHT als Preis behandeln — depositValue separat in den Roh-Kontext.
  const depositValue =
    parseDecimal(numberText(price.depositValue)) ??
    parseDecimal(numberText(firstPromotion.depositValue)) ??
    parseDecimal(numberText(value.depositValue));

  const candidate = buildCandidate({
    storeChain: store.storeChain,
    name: displayName,
    brand: textValue(value.brandName),
    price: priceValue,
    originalPrice: parseDecimal(
      numberText(currentStrike.strikePriceValue ?? promoStrike.strikePriceValue),
    ),
    unit: textValue(value.salesUnit),
    basePrice: parseDecimal(numberText(basePriceSource?.basePriceValue)),
    baseUnit: textValue(basePriceSource?.basePriceScale),
    imageUrl,
    sourceUrl: resolveUrl(sourcePath, store.url) ?? store.url,
    category,
    validityStart,
    validityEnd,
    tags: [ALDI_NORD_STRUCTURED_TAG],
  });

  if (candidate) {
    // objectID ist die stabile Dedupe-Identität; Bereich/Quelle als Roh-Signale.
    if (objectId) candidate.sourceId = objectId;
    const sourceTags = [ALDI_NORD_STRUCTURED_TAG, ...areaTitles];
    const mainCategory = textValue(value.mainCategoryID);
    if (mainCategory) sourceTags.push(mainCategory);
    candidate.sourceTagsRaw = [...new Set(sourceTags)];
    const contextParts: string[] = [];
    if (depositValue) contextParts.push(`Pfand: ${depositValue.toFixed(2)} EUR`);
    if (areaTitles.length > 0) contextParts.push(`Bereich: ${areaTitles.join(' · ')}`);
    if (contextParts.length > 0) candidate.sourceContextRaw = contextParts.join(' | ');
  }

  return {
    candidate,
    objectId,
    name: displayName || (textValue(value.name) ?? ''),
    hadPrice: priceValue !== undefined,
    hadValidity: Boolean(validityStart || validityEnd),
    hadImage: Boolean(imageUrl),
  };
}

/** Bereichs-/Roh-Signale eines Duplikats in die behaltene Offer mergen, ohne die
 *  Offer-Zeile zu verdoppeln. */
function mergeAldiNordAreas(target: RawOfferCandidate, duplicate: RawOfferCandidate): void {
  const tags = new Set([...(target.sourceTagsRaw ?? []), ...(duplicate.sourceTagsRaw ?? [])]);
  target.sourceTagsRaw = [...tags];
  const categories = new Set(
    [target.sourceCategoryRaw, duplicate.sourceCategoryRaw]
      .filter((c): c is string => Boolean(c))
      .flatMap((c) => c.split(' · ')),
  );
  if (categories.size > 0) target.sourceCategoryRaw = [...categories].join(' · ');
}

/**
 * ALDI NORD strukturiert aus dem öffentlichen HTML lesen + die maschinenlesbare
 * Zählkette bauen. Pure (kein IO). Dedupe primär über objectID; ein Produkt, das
 * in mehreren Bereichen liegt, bleibt EINE Offer-Zeile, behält aber alle Bereiche
 * (sourceCategoryRaw/sourceTagsRaw). Future-Angebote (validityStart > now) werden
 * importiert + gezählt; die current/upcoming-Trennung übernimmt der zentrale
 * Snapshot-Split (classifyOfferBucket/offerWeek).
 */
export function parseAldiNordOffers(
  html: string,
  store: OfficialStoreConfig,
  options: { httpStatus?: number; now?: Date } = {},
): { offers: RawOfferCandidate[]; diagnostics: AldiNordImportDiagnostics } {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const apiData = extractAldiNordApiData(html);

  const baseDiagnostics = (): AldiNordImportDiagnostics => ({
    generatedAt,
    sourceUrl: store.url,
    apiDataFound: apiData !== null,
    blocked: false,
    httpStatus: options.httpStatus,
    structuredProductsFound: 0,
    productsWithPrice: 0,
    productsWithValidity: 0,
    productsWithImage: 0,
    futureProducts: 0,
    currentProducts: 0,
    importedDistinct: 0,
    duplicatesMerged: 0,
    areaCount: 0,
    missingPriceExamples: [],
    missingValidityExamples: [],
    missingImageExamples: [],
  });

  if (apiData === null) {
    return { offers: [], diagnostics: baseDiagnostics() };
  }

  const areas = collectAldiNordAreas(apiData);
  const areaIndex = buildAldiNordAreaIndex(areas);
  const products = collectAldiNordProducts(apiData);

  const diagnostics = baseDiagnostics();
  diagnostics.areaCount = areas.length;
  diagnostics.structuredProductsFound = products.length;

  const missingPrice: string[] = [];
  const missingValidity: string[] = [];
  const missingImage: string[] = [];
  const pushExample = (list: string[], name: string): void => {
    const label = name.trim();
    if (label && list.length < ALDI_NORD_EXAMPLE_CAP && !list.includes(label)) {
      list.push(label);
    }
  };

  // Dedupe primär über objectID (Fallback: candidate.id), Bereiche zusammenführen.
  const byKey = new Map<string, RawOfferCandidate>();
  let built = 0;
  for (const product of products) {
    const parse = parseAldiNordProduct(product, store, areaIndex);
    if (parse.hadPrice) diagnostics.productsWithPrice += 1;
    else pushExample(missingPrice, parse.name);
    if (parse.hadValidity) diagnostics.productsWithValidity += 1;
    else pushExample(missingValidity, parse.name);
    if (parse.hadImage) diagnostics.productsWithImage += 1;
    else pushExample(missingImage, parse.name);

    if (!parse.candidate) continue;
    built += 1;
    const key = parse.objectId ?? parse.candidate.id ?? parse.candidate.name;
    const existing = byKey.get(key);
    if (existing) {
      mergeAldiNordAreas(existing, parse.candidate);
      continue;
    }
    byKey.set(key, parse.candidate);
  }

  const offers = [...byKey.values()];
  diagnostics.importedDistinct = offers.length;
  diagnostics.duplicatesMerged = Math.max(0, built - offers.length);
  diagnostics.missingPriceExamples = missingPrice;
  diagnostics.missingValidityExamples = missingValidity;
  diagnostics.missingImageExamples = missingImage;
  for (const offer of offers) {
    if (classifyOfferBucket(offer, now) === 'upcoming') diagnostics.futureProducts += 1;
    else diagnostics.currentProducts += 1;
  }
  diagnostics.lastSuccessfulAt = offers.length > 0 ? generatedAt : undefined;

  return { offers, diagnostics };
}

/** Back-compat-Wrapper (Test-API + Dispatch): nur die Angebote, ohne Diagnose. */
function parseAldiNordApiData(
  html: string,
  store: OfficialStoreConfig,
): RawOfferCandidate[] {
  return parseAldiNordOffers(html, store).offers;
}

// Letzte ALDI-NORD-Import-Diagnose dieses Prozesses (analog EDEKA/Kaufland): wird
// beim Scrape gesetzt und vom Scan-Report gelesen, ohne erneut zu fetchen.
let lastAldiNordDiagnostics: AldiNordImportDiagnostics | null = null;

export function getLastAldiNordDiagnostics(): AldiNordImportDiagnostics | null {
  return lastAldiNordDiagnostics;
}

/** Block-/Fehlerdiagnose, wenn der ALDI-NORD-Fetch gar nicht durchkam
 *  (403/Captcha/Timeout) — damit der Report ALDI NORD ehrlich als
 *  blocked/fetch_failed zeigt statt still „ok". */
function recordAldiNordFetchFailure(store: OfficialStoreConfig, error: unknown): void {
  const message = error instanceof Error ? error.message : 'unbekannter Fehler';
  const statusMatch = message.match(/\b(\d{3})\b/);
  lastAldiNordDiagnostics = {
    generatedAt: new Date().toISOString(),
    sourceUrl: store.url,
    apiDataFound: false,
    blocked: true,
    blockReason: message,
    httpStatus: statusMatch ? Number(statusMatch[1]) : undefined,
    structuredProductsFound: 0,
    productsWithPrice: 0,
    productsWithValidity: 0,
    productsWithImage: 0,
    futureProducts: 0,
    currentProducts: 0,
    importedDistinct: 0,
    duplicatesMerged: 0,
    areaCount: 0,
    missingPriceExamples: [],
    missingValidityExamples: [],
    missingImageExamples: [],
    lastSuccessfulAt: lastAldiNordDiagnostics?.lastSuccessfulAt,
  };
}

/** ALDI-NORD-Import-Diagnose zur Scrape-Zeit erfassen (analog EDEKA): setzt die
 *  Zählkette + apiData-/blocked-Status, ohne erneut zu fetchen. Best-effort —
 *  bricht den Scrape nie ab. */
function captureAldiNordDiagnostics(
  html: string,
  store: OfficialStoreConfig,
  warnings: string[],
): void {
  try {
    const { offers, diagnostics } = parseAldiNordOffers(html, store);
    // Letzten Erfolgszeitpunkt über 0-/Block-Läufe hinweg behalten.
    if (!diagnostics.lastSuccessfulAt && lastAldiNordDiagnostics?.lastSuccessfulAt) {
      diagnostics.lastSuccessfulAt = lastAldiNordDiagnostics.lastSuccessfulAt;
    }
    lastAldiNordDiagnostics = diagnostics;

    if (offers.length === 0) {
      warnings.push(
        diagnostics.apiDataFound
          ? `${store.storeChain}: apiData gefunden, aber 0 strukturierte Angebote (${diagnostics.structuredProductsFound} Produkte, ${diagnostics.productsWithPrice} mit Preis) — Quelle/Parser prüfen.`
          : `${store.storeChain}: kein apiData/__NEXT_DATA__ auf der Angebotsseite — Layout evtl. geändert.`,
      );
    }
  } catch {
    // Diagnose ist best-effort; ein Parserfehler darf den Scrape nicht stoppen.
  }
}

// ── ALDI SÜD: strukturierter Website-Connector (__NUXT_DATA__) ───────────────
// Die zentrale Wochenangebote-Sammelseite liefert die Produkte serverseitig
// gerendert (HTTP 200): als stabile DOM-Kacheln (data-test="product-tile…") UND
// maschinenlesbar im Nuxt-3-Payload <script id="__NUXT_DATA__">. Dort steht pro
// Produkt ein typisierter Datensatz (sku, name, brandName, sellingSize,
// price{amount/bottleDeposit/comparison/wasPriceDisplay}, assets, categories,
// onSaleDateDisplay). Die Sammelseite paginiert über ?page=2,3,… — Seite 1 ohne
// page-Parameter. KEIN Login, kein PDF/OCR/Vision, kein Anti-Bot-Bypass — nur die
// regulär ausgelieferte Seite. Pfand (bottleDeposit) und Grundpreis (comparison)
// werden NIE als Angebotspreis übernommen; der Angebotspreis kommt ausschließlich
// aus price.amount/amountRelevant. Marken/Produkte sind nie hardcodiert — Red Bull
// erscheint nur, wenn die echte Quelle es liefert.

const ALDI_SUED_STRUCTURED_TAG = 'aldi-sued-structured';
const ALDI_SUED_EXAMPLE_CAP = 8;
const ALDI_SUED_IMAGE_WIDTH = 500;
const ALDI_SUED_IMAGE_WARN_SHARE = 0.5;
/** Harte Obergrenze gegen Endlos-Pagination (Safety-Net). */
const ALDI_SUED_MAX_PAGES = 10;

/** Die zentrale, öffentlich verlinkte Wochenangebote-Sammelseite. Seite 1 ist die
 *  Basis-URL ohne page-Parameter; Folgeseiten kommen über ?page=2,3,… */
const ALDI_SUED_COLLECTION_SOURCE: { url: string; label: string } = {
  url: 'https://www.aldi-sued.de/produkte/wochenangebote/k/1588161426582123',
  label: 'Wochenangebote',
};

/** Page-N-URL der Sammelseite bilden: Seite 1 = Basis-URL, danach ?page=N. */
function aldiSuedPageUrl(baseUrl: string, page: number): string {
  if (page <= 1) return baseUrl;
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('page', String(page));
    return url.toString();
  } catch {
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}page=${page}`;
  }
}

/** Eine geprüfte Seite der Sammelseite (page N) für die Diagnose. */
export interface AldiSuedSourceCheck {
  url: string;
  /** 1-basierte Seitenzahl (Seite 1 = Basis-URL ohne page-Parameter). */
  page?: number;
  status?: number;
  contentType?: string;
  blocked: boolean;
  blockReason?: string;
  /** DOM-Produktkacheln (data-test="product-tile"). */
  htmlProductCards: number;
  /** __NUXT_DATA__ vorhanden + als Array parsebar. */
  embeddedJsonFound: boolean;
  /** JSON-LD Product/Offer-Knoten (≠ BreadcrumbList). */
  jsonLdOffers: number;
  /** data-grid-data-Attribute (Lidl-Stil) — i. d. R. 0 bei ALDI SÜD. */
  dataGridDataCount: number;
  /** Öffentliche api/rest/search-Endpunkt-Kandidaten im HTML. */
  apiCandidatesFound: number;
  /** Strukturierte Produkte, die auf DIESER Seite parsebar waren. */
  productsParsed: number;
  /** Neue (bisher ungesehene) Produkt-IDs/SKUs, die diese Seite beigetragen hat. */
  newProducts?: number;
}

export type AldiSuedVerdict = 'ok' | 'warning' | 'blocked' | 'unavailable';

export interface AldiSuedImportDiagnostics {
  generatedAt: string;
  sourceUrlsChecked: AldiSuedSourceCheck[];
  /** Anzahl tatsächlich abgerufener Seiten (= sourceUrlsChecked.length). */
  pagesChecked?: number;
  /** Seiten, die ≥1 parsebares Produkt lieferten. */
  pagesWithProducts?: number;
  // ── Aggregierte Zählkette: Struktur → Preis → Bild → Gültigkeit → current/future
  structuredProductsFound: number;
  productsWithPrice: number;
  productsWithImage: number;
  productsWithValidity: number;
  currentProducts: number;
  futureProducts: number;
  importedDistinct: number;
  duplicatesMerged: number;
  // ── Beispiele bei fehlendem Preis/Bild/Datum (nie riesige Listen) ───────────
  missingPriceExamples: string[];
  missingImageExamples: string[];
  missingValidityExamples: string[];
  verdict: AldiSuedVerdict;
  blocked: boolean;
  blockReason?: string;
  /** Zeitpunkt des letzten Laufs in diesem Prozess mit ≥1 Angebot. */
  lastSuccessfulAt?: string;
}

/** Deutsche Monatsnamen → 1-basierte Monatszahl (für „Ab Montag, 29. Juni"). */
const ALDI_SUED_GERMAN_MONTHS: Record<string, number> = {
  januar: 1,
  februar: 2,
  maerz: 3,
  märz: 3,
  april: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  september: 9,
  oktober: 10,
  november: 11,
  dezember: 12,
};

function aldiSuedIsoFromParts(
  year: number,
  month: number,
  day: number,
): string | undefined {
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}T00:00:00.000Z`;
}

/** Jahr für einen tag/monatslosen Treffer schätzen: das nächste Vorkommen ab
 *  (now − 7 Tagen), damit ein „ab Montag"-Datum aus dem Jahreswechsel nicht
 *  fälschlich ein Jahr in der Vergangenheit landet. */
function aldiSuedInferYear(month: number, day: number, now: Date): number {
  const year = now.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  const floor = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  return candidate >= floor ? year : year + 1;
}

/** onSaleDateDisplay → ISO-Tagesstart. Unterstützt ISO (YYYY-MM-DD…),
 *  dd.mm.yyyy / dd.mm. und „Ab Montag, 29. Juni". Kein Treffer = undefined
 *  (= aktuelle Woche, kein erzwungenes Datum). */
function parseAldiSuedSaleDate(
  value: string | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!value) return undefined;
  const text = value.trim();

  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return aldiSuedIsoFromParts(
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
    );
  }

  const numericMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
  if (numericMatch) {
    const day = Number(numericMatch[1]);
    const month = Number(numericMatch[2]);
    const year = numericMatch[3]
      ? Number(numericMatch[3])
      : aldiSuedInferYear(month, day, now);
    return aldiSuedIsoFromParts(year, month, day);
  }

  const germanMatch = text.match(/(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)/);
  if (germanMatch) {
    const day = Number(germanMatch[1]);
    const month = ALDI_SUED_GERMAN_MONTHS[germanMatch[2].toLowerCase()];
    if (month) {
      return aldiSuedIsoFromParts(aldiSuedInferYear(month, day, now), month, day);
    }
  }

  return undefined;
}

/** Cent-Ganzzahl (z. B. 99) → Euro (0,99). Nur positive, endliche Werte. */
function aldiSuedCentsToEuro(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Number((value / 100).toFixed(2));
}

/** Asset-Template (…/scaleWidth/{width}/<uuid>/{slug}) zu einer konkreten,
 *  öffentlich ausgelieferten Bild-URL auflösen. */
function buildAldiSuedImageUrl(
  template: string | undefined,
  name: string,
  baseUrl: string,
): string | undefined {
  if (!template) return undefined;
  const filled = template
    .replace(/\{width\}/g, String(ALDI_SUED_IMAGE_WIDTH))
    .replace(/\{slug\}/g, encodeURIComponent(stripHtml(name) || 'product'));
  return resolveUrl(filled, baseUrl);
}

/** Nuxt-3-Payload (<script id="__NUXT_DATA__">) als devalue-Array lesen. Das
 *  Array enthält flache Werte; Objekt-/Array-Felder sind Indizes (Referenzen) in
 *  dasselbe Array. Rückgabe: das rohe Array oder null. */
function extractNuxtDataArray(html: string): unknown[] | null {
  const match = html.match(
    /<script[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Einen devalue-Referenzwert (Index) ins konkrete JS-Objekt auflösen. Objekt-/
 *  Array-Felder sind erneut Indizes; eine primitive Blattzelle (Zahl/String) wird
 *  unverändert zurückgegeben — eine Zahl in einer Blattzelle ist KEIN weiterer
 *  Index. Negative/Out-of-range-Indizes (devalue-Spezialwerte wie undefined/hole)
 *  → undefined. */
function createNuxtResolver(
  arr: unknown[],
): (ref: unknown, depth?: number) => unknown {
  const resolve = (ref: unknown, depth = 0): unknown => {
    if (depth > 8) return undefined;
    if (typeof ref !== 'number') return ref;
    if (!Number.isInteger(ref) || ref < 0 || ref >= arr.length) return undefined;
    const value = arr[ref];
    if (Array.isArray(value)) {
      return value.map((entry) => resolve(entry, depth + 1));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, childRef] of Object.entries(value)) {
        out[key] = resolve(childRef, depth + 1);
      }
      return out;
    }
    return value;
  };
  return resolve;
}

/** Eine rohe devalue-Zelle ist ein ALDI-SÜD-Produkt, wenn sie die typische
 *  Produkt-Signatur trägt (Marke + Preis + Name + sku/abstractSku). Generisch —
 *  keine Marken-/Produkt-/KW-Hardcodes. */
function isAldiSuedProductCell(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    'brandName' in value &&
    'price' in value &&
    'name' in value &&
    ('sku' in value || 'abstractSku' in value)
  );
}

interface AldiSuedProductParse {
  candidate: RawOfferCandidate | null;
  sku?: string;
  name: string;
  hadPrice: boolean;
  hadImage: boolean;
  hadValidity: boolean;
}

/** Einen aufgelösten Produktdatensatz in einen RawOfferCandidate mappen. Pure.
 *  Pfand + Grundpreis bleiben strikt vom Angebotspreis getrennt. */
function parseAldiSuedProduct(
  product: Record<string, unknown>,
  store: OfficialStoreConfig,
  pageLabel: string,
  now: Date,
): AldiSuedProductParse {
  const rawName = textValue(product.name) ?? '';
  const brand = textValue(product.brandName);
  const displayName = composeAldiNordName(rawName, brand);

  const price = isRecord(product.price) ? product.price : {};
  // Angebotspreis NUR aus amount/amountRelevant (Cent) bzw. dem Anzeigepreis —
  // NIE aus bottleDeposit (Pfand) oder comparison (Grundpreis).
  const offerPrice =
    aldiSuedCentsToEuro(price.amountRelevant) ??
    aldiSuedCentsToEuro(price.amount) ??
    parseDecimal(textValue(price.amountRelevantDisplay));
  // UVP / Streichpreis (optional): wasPriceDisplay "7,99 €".
  const originalPrice = parseDecimal(textValue(price.wasPriceDisplay));
  // Grundpreis: comparisonDisplay "3,96 €/1 l" → basePrice + baseUnit.
  const base = parseBasePriceText(textValue(price.comparisonDisplay));
  // Pfand getrennt (nur Roh-Kontext): bottleDeposit (Cent) + Typ.
  const depositValue = aldiSuedCentsToEuro(price.bottleDeposit);
  const depositType = textValue(price.bottleDepositType);

  const unit = textValue(product.sellingSize);

  const assets = Array.isArray(product.assets) ? product.assets.filter(isRecord) : [];
  const imageUrl = buildAldiSuedImageUrl(
    textValue(assets[0]?.url),
    displayName || rawName,
    store.url,
  );

  // Gültigkeit: onSaleDateDisplay (Datum/Display) → künftige Angebote bekommen
  // validityStart = Startdatum, damit der zentrale Bucket-Split sie aus
  // current/Cheffity-current heraushält. Kein Datum = aktuelle Woche: Start = now
  // (deterministisch aus dem injizierten now, nicht aus einer verborgenen
  // Echtzeit), Ende = now + 6 Tage (ALDI-SÜD-Wochenfenster).
  const rawSaleDate = textValue(product.onSaleDateDisplay);
  const saleStart = parseAldiSuedSaleDate(rawSaleDate, now);
  const nowIso = now.toISOString();
  const validityStart = saleStart ?? nowIso;
  const validityEnd = saleStart
    ? addDaysIso(saleStart, 6, true)
    : addDaysIso(nowIso, 6, true);
  // hadValidity nur dann false, wenn ein Datums-Display existiert, das wir NICHT
  // parsen konnten (echte Lücke) — null/leer = aktuelle Woche = bekannt.
  const hadValidity = rawSaleDate === undefined || saleStart !== undefined;

  const sku = textValue(product.sku) ?? textValue(product.abstractSku);
  const slug = textValue(product.urlSlugText);
  const sourcePath = slug && sku ? `/produkt/${slug}-${sku}` : '/angebote';

  const categoryNames = Array.isArray(product.categories)
    ? product.categories
        .filter(isRecord)
        .map((entry) => textValue(entry.name))
        .filter((entry): entry is string => Boolean(entry))
    : [];
  const category =
    [pageLabel, ...categoryNames].filter(Boolean).join(' · ') || pageLabel;

  const candidate = buildCandidate({
    storeChain: store.storeChain,
    name: displayName,
    brand,
    price: offerPrice,
    originalPrice,
    unit,
    basePrice: base.basePrice,
    baseUnit: base.baseUnit,
    imageUrl,
    sourceUrl: resolveUrl(sourcePath, store.url) ?? store.url,
    category,
    validityStart,
    validityEnd,
    tags: [ALDI_SUED_STRUCTURED_TAG],
  });

  if (candidate) {
    if (sku) candidate.sourceId = sku;
    const contextParts: string[] = [];
    if (depositValue) {
      contextParts.push(
        `Pfand: ${depositValue.toFixed(2)} EUR${depositType ? ` (${depositType})` : ''}`,
      );
    }
    if (contextParts.length > 0) {
      candidate.sourceContextRaw = contextParts.join(' | ');
    }
  }

  return {
    candidate,
    sku,
    name: displayName || rawName,
    hadPrice: offerPrice !== undefined,
    hadImage: Boolean(imageUrl),
    hadValidity,
  };
}

export interface AldiSuedPageParse {
  offers: RawOfferCandidate[];
  parses: AldiSuedProductParse[];
  sourceCheck: AldiSuedSourceCheck;
}

/** Generische Quell-Signale einer HTML-Seite zählen (für die Diagnose). */
function countAldiSuedSourceSignals(html: string): {
  htmlProductCards: number;
  jsonLdOffers: number;
  dataGridDataCount: number;
  apiCandidatesFound: number;
} {
  const htmlProductCards = (html.match(/data-test="product-tile"/g) || []).length;
  const jsonLdOffers = (html.match(/"@type"\s*:\s*"(?:Offer|Product)"/g) || []).length;
  const dataGridDataCount = (html.match(/data-grid-data=/g) || []).length;
  const apiCandidatesFound = new Set(
    html.match(
      /https?:\/\/[a-z0-9.-]*aldi-sued\.de\/[^"'\s]*\/(?:api|rest|graphql|search)\/[^"'\s]*/gi,
    ) || [],
  ).size;
  return { htmlProductCards, jsonLdOffers, dataGridDataCount, apiCandidatesFound };
}

/**
 * Eine ALDI-SÜD-Kategorieseite parsen: primär die strukturierten __NUXT_DATA__-
 * Produkte; nur wenn diese fehlen UND echte HTML-200-DOM-Kacheln vorhanden sind,
 * greift der DOM-Kachel-Fallback. Pure (kein IO).
 */
export function parseAldiSuedPage(
  html: string,
  url: string,
  label: string,
  store: OfficialStoreConfig,
  now: Date = new Date(),
): AldiSuedPageParse {
  const signals = countAldiSuedSourceSignals(html);
  const arr = extractNuxtDataArray(html);
  const sourceCheck: AldiSuedSourceCheck = {
    url,
    status: 200,
    blocked: false,
    htmlProductCards: signals.htmlProductCards,
    embeddedJsonFound: arr !== null,
    jsonLdOffers: signals.jsonLdOffers,
    dataGridDataCount: signals.dataGridDataCount,
    apiCandidatesFound: signals.apiCandidatesFound,
    productsParsed: 0,
  };

  const parses: AldiSuedProductParse[] = [];
  const offers: RawOfferCandidate[] = [];
  const pageStore: OfficialStoreConfig = { ...store, url };

  if (arr) {
    const resolve = createNuxtResolver(arr);
    for (let index = 0; index < arr.length; index += 1) {
      if (!isAldiSuedProductCell(arr[index])) continue;
      const resolved = resolve(index);
      if (!isRecord(resolved)) continue;
      const parse = parseAldiSuedProduct(resolved, pageStore, label, now);
      parses.push(parse);
      if (parse.candidate) offers.push(parse.candidate);
    }
  }

  // Fallback: echtes HTML 200 mit DOM-Kacheln, aber kein/leeres __NUXT_DATA__ →
  // DOM-Kachel-Parser. NUR weil der Backend-Fetch wirklich HTML 200 lieferte.
  if (offers.length === 0 && signals.htmlProductCards > 0) {
    offers.push(...parseAldiProductTiles(html, pageStore));
  }

  sourceCheck.productsParsed = offers.length;
  return { offers, parses, sourceCheck };
}

/** Ergebnis eines (gemockten oder echten) Fetches einer Sammelseiten-Seite. */
export type AldiSuedFetchResult =
  | {
      url: string;
      label: string;
      ok: true;
      status: number;
      contentType?: string;
      html: string;
    }
  | {
      url: string;
      label: string;
      ok: false;
      status?: number;
      contentType?: string;
      blockReason: string;
    };

/** Lädt genau eine Sammelseiten-Seite (page N). Injizierbar → testbar ohne Netz. */
export type AldiSuedPageFetcher = (
  url: string,
  page: number,
) => Promise<AldiSuedFetchResult>;

/** Akkumulierter Zustand über alle bisher abgerufenen Seiten der Sammelseite. */
interface AldiSuedAccumulator {
  sourceUrlsChecked: AldiSuedSourceCheck[];
  allParses: AldiSuedProductParse[];
  byKey: Map<string, RawOfferCandidate>;
  seenKeys: Set<string>;
  built: number;
  firstPageBlocked: boolean;
  laterPageBlocked: boolean;
}

function newAldiSuedAccumulator(): AldiSuedAccumulator {
  return {
    sourceUrlsChecked: [],
    allParses: [],
    byKey: new Map<string, RawOfferCandidate>(),
    seenKeys: new Set<string>(),
    built: 0,
    firstPageBlocked: false,
    laterPageBlocked: false,
  };
}

/**
 * Eine abgerufene Seite in den Akkumulator einarbeiten. Dedupe über sku (Fallback
 * id/Name) gegen ALLE vorherigen Seiten. Rückgabe: `true` = Pagination stoppen.
 * Stop-Kriterien:
 *   • Seite blockiert / kein HTTP 200
 *   • 0 parsebare Produkte (kein HTML / keine __NUXT_DATA__ / leere Seite)
 *   • keine neuen Produkt-IDs/SKUs ggü. vorherigen Seiten (reine Dubletten-Seite)
 */
function ingestAldiSuedPage(
  acc: AldiSuedAccumulator,
  result: AldiSuedFetchResult,
  page: number,
  store: OfficialStoreConfig,
  now: Date,
): boolean {
  if (!result.ok) {
    acc.sourceUrlsChecked.push({
      url: result.url,
      page,
      status: result.status,
      contentType: result.contentType,
      blocked: true,
      blockReason: result.blockReason,
      htmlProductCards: 0,
      embeddedJsonFound: false,
      jsonLdOffers: 0,
      dataGridDataCount: 0,
      apiCandidatesFound: 0,
      productsParsed: 0,
      newProducts: 0,
    });
    if (page <= 1) acc.firstPageBlocked = true;
    else acc.laterPageBlocked = true;
    return true; // blockierte Seite → Pagination stoppen
  }

  const parsed = parseAldiSuedPage(result.html, result.url, result.label, store, now);
  parsed.sourceCheck.status = result.status;
  parsed.sourceCheck.contentType = result.contentType;
  parsed.sourceCheck.page = page;
  acc.allParses.push(...parsed.parses);

  let newCount = 0;
  for (const offer of parsed.offers) {
    acc.built += 1;
    const key = offer.sourceId ?? offer.id ?? offer.name;
    if (!acc.seenKeys.has(key)) {
      acc.seenKeys.add(key);
      acc.byKey.set(key, offer);
      newCount += 1;
    }
  }
  parsed.sourceCheck.newProducts = newCount;
  acc.sourceUrlsChecked.push(parsed.sourceCheck);

  // 0 parsebare Produkte (leere Seite / keine __NUXT_DATA__) → Ende erreicht.
  if (parsed.offers.length === 0) return true;
  // Nur Dubletten ggü. vorherigen Seiten → keine neuen Daten mehr, Ende erreicht.
  if (newCount === 0) return true;
  return false;
}

/**
 * Akkumulierten Zustand → Angebote + Diagnose. Future-Angebote (validityStart >
 * now) werden importiert + gezählt; die current/upcoming-Trennung übernimmt der
 * zentrale Snapshot-Split (classifyOfferBucket).
 */
function finalizeAldiSuedDiagnostics(
  acc: AldiSuedAccumulator,
  now: Date,
): { offers: RawOfferCandidate[]; diagnostics: AldiSuedImportDiagnostics } {
  const generatedAt = now.toISOString();
  const offers = [...acc.byKey.values()];

  const missingPriceExamples: string[] = [];
  const missingImageExamples: string[] = [];
  const missingValidityExamples: string[] = [];
  const pushExample = (list: string[], name: string): void => {
    const label = name.trim();
    if (label && list.length < ALDI_SUED_EXAMPLE_CAP && !list.includes(label)) {
      list.push(label);
    }
  };
  let productsWithPrice = 0;
  let productsWithImage = 0;
  let productsWithValidity = 0;
  for (const parse of acc.allParses) {
    if (parse.hadPrice) productsWithPrice += 1;
    else pushExample(missingPriceExamples, parse.name);
    if (parse.hadImage) productsWithImage += 1;
    else pushExample(missingImageExamples, parse.name);
    if (parse.hadValidity) productsWithValidity += 1;
    else pushExample(missingValidityExamples, parse.name);
  }

  let futureProducts = 0;
  for (const offer of offers) {
    if (classifyOfferBucket(offer, now) === 'upcoming') futureProducts += 1;
  }
  const currentProducts = offers.length - futureProducts;

  const pagesChecked = acc.sourceUrlsChecked.length;
  const reachable = acc.sourceUrlsChecked.filter((source) => !source.blocked).length;
  const blockedCount = pagesChecked - reachable;
  const pagesWithProducts = acc.sourceUrlsChecked.filter(
    (source) => source.productsParsed > 0,
  ).length;
  const structuredProductsFound = acc.allParses.length;
  const imageShare =
    structuredProductsFound > 0 ? productsWithImage / structuredProductsFound : 1;

  // verdict-Politik:
  //   • Seite 1 blockiert (→ 0 Angebote) ⇒ blocked.
  //   • Angebote vorhanden, aber spätere Seite blockiert / Bildabdeckung dünn
  //     ⇒ warning (Teilimport, kein Hard-Fail).
  //   • Pagination sauber beendet mit Angeboten ⇒ ok.
  //   • Seite 1 erreichbar, aber 0 strukturierte Produkte ⇒ unavailable.
  let verdict: AldiSuedVerdict;
  if (offers.length > 0) {
    verdict =
      acc.laterPageBlocked || blockedCount > 0 || imageShare < ALDI_SUED_IMAGE_WARN_SHARE
        ? 'warning'
        : 'ok';
  } else if (reachable === 0) {
    verdict = 'blocked';
  } else {
    verdict = 'unavailable';
  }

  const allBlocked = pagesChecked > 0 && reachable === 0;

  const diagnostics: AldiSuedImportDiagnostics = {
    generatedAt,
    sourceUrlsChecked: acc.sourceUrlsChecked,
    pagesChecked,
    pagesWithProducts,
    structuredProductsFound,
    productsWithPrice,
    productsWithImage,
    productsWithValidity,
    currentProducts,
    futureProducts,
    importedDistinct: offers.length,
    duplicatesMerged: Math.max(0, acc.built - offers.length),
    missingPriceExamples,
    missingImageExamples,
    missingValidityExamples,
    verdict,
    blocked: allBlocked,
    blockReason: allBlocked
      ? acc.sourceUrlsChecked.find((source) => source.blockReason)?.blockReason
      : undefined,
    lastSuccessfulAt: offers.length > 0 ? generatedAt : undefined,
  };

  return { offers, diagnostics };
}

/**
 * Reine Aggregation bereits abgerufener Sammelseiten-Seiten (in Reihenfolge) →
 * Angebote + Diagnose. Wendet dieselben Stop-Kriterien wie der Live-Treiber an:
 * verarbeitet nur bis zur ersten Stop-Seite (blockiert / leer / nur Dubletten)
 * bzw. bis maxPages. Pure + testbar ohne Netzwerk.
 */
export function aggregateAldiSuedPages(
  pageResults: AldiSuedFetchResult[],
  store: OfficialStoreConfig,
  now: Date = new Date(),
  options: { maxPages?: number } = {},
): { offers: RawOfferCandidate[]; diagnostics: AldiSuedImportDiagnostics } {
  const maxPages = options.maxPages ?? ALDI_SUED_MAX_PAGES;
  const acc = newAldiSuedAccumulator();
  const limit = Math.min(pageResults.length, maxPages);
  for (let page = 1; page <= limit; page += 1) {
    const stop = ingestAldiSuedPage(acc, pageResults[page - 1], page, store, now);
    if (stop) break;
  }
  return finalizeAldiSuedDiagnostics(acc, now);
}

/**
 * Sammelseite mit Pagination abklappern: Seite 1 (Basis-URL), dann ?page=2,3,…
 * bis ein Stop-Kriterium greift oder maxPages erreicht ist. Der Page-Fetcher ist
 * injizierbar → der gesamte Pagination-/Stop-/Dedupe-Pfad ist ohne Netzwerk
 * testbar. Kein Anti-Bot-Bypass, keine privaten APIs.
 */
export async function collectAldiSuedPaginatedOffers(
  fetchPage: AldiSuedPageFetcher,
  store: OfficialStoreConfig,
  now: Date = new Date(),
  options: { baseUrl?: string; label?: string; maxPages?: number } = {},
): Promise<{ offers: RawOfferCandidate[]; diagnostics: AldiSuedImportDiagnostics }> {
  const baseUrl = options.baseUrl ?? ALDI_SUED_COLLECTION_SOURCE.url;
  const label = options.label ?? ALDI_SUED_COLLECTION_SOURCE.label;
  const maxPages = options.maxPages ?? ALDI_SUED_MAX_PAGES;
  const acc = newAldiSuedAccumulator();

  for (let page = 1; page <= maxPages; page += 1) {
    const url = aldiSuedPageUrl(baseUrl, page);
    let result: AldiSuedFetchResult;
    try {
      result = await fetchPage(url, page);
    } catch (error) {
      result = {
        url,
        label,
        ok: false,
        blockReason: error instanceof Error ? error.message : 'unbekannter Fehler',
      };
    }
    const stop = ingestAldiSuedPage(acc, result, page, store, now);
    if (stop) break;
  }

  return finalizeAldiSuedDiagnostics(acc, now);
}

// Letzte ALDI-SÜD-Import-Diagnose dieses Prozesses (analog ALDI NORD): wird beim
// Scrape gesetzt und vom Scan-Report / StoreImportHealth gelesen, ohne erneut zu
// fetchen.
let lastAldiSuedDiagnostics: AldiSuedImportDiagnostics | null = null;

export function getLastAldiSuedDiagnostics(): AldiSuedImportDiagnostics | null {
  return lastAldiSuedDiagnostics;
}

/** Block-/Fehlerdiagnose, wenn der ALDI-SÜD-Fetch (Store-Timeout o. ä.) gar nicht
 *  durchkam — damit der Report ALDI SÜD ehrlich als blocked zeigt statt still
 *  „0 Angebote". */
function recordAldiSuedFetchFailure(
  _store: OfficialStoreConfig,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : 'unbekannter Fehler';
  lastAldiSuedDiagnostics = {
    generatedAt: new Date().toISOString(),
    sourceUrlsChecked: [
      {
        url: ALDI_SUED_COLLECTION_SOURCE.url,
        page: 1,
        blocked: true,
        blockReason: message,
        htmlProductCards: 0,
        embeddedJsonFound: false,
        jsonLdOffers: 0,
        dataGridDataCount: 0,
        apiCandidatesFound: 0,
        productsParsed: 0,
        newProducts: 0,
      },
    ],
    pagesChecked: 1,
    pagesWithProducts: 0,
    structuredProductsFound: 0,
    productsWithPrice: 0,
    productsWithImage: 0,
    productsWithValidity: 0,
    currentProducts: 0,
    futureProducts: 0,
    importedDistinct: 0,
    duplicatesMerged: 0,
    missingPriceExamples: [],
    missingImageExamples: [],
    missingValidityExamples: [],
    verdict: 'blocked',
    blocked: true,
    blockReason: message,
    lastSuccessfulAt: lastAldiSuedDiagnostics?.lastSuccessfulAt,
  };
}

function parseLidlProductGridData(
  html: string,
  store: OfficialStoreConfig,
): RawOfferCandidate[] {
  const offers: RawOfferCandidate[] = [];
  const gridDataAttributes = html.matchAll(/\sdata-grid-data=["']([^"']+)["']/gi);

  for (const attribute of gridDataAttributes) {
    const parsed = parseHtmlJsonAttribute(attribute[1]);
    if (!isRecord(parsed)) {
      continue;
    }
    if (parsed.store !== true && parsed.store !== 'true') {
      continue;
    }

    const price = isRecord(parsed.price) ? parsed.price : {};
    const discount = isRecord(price.discount) ? price.discount : {};
    const name =
      textValue(parsed.fullTitle) ?? textValue(parsed.title) ?? textValue(parsed.name);
    const image = textValue(parsed.image) ?? textValue(isRecord(parsed.image_V1) ? parsed.image_V1.image : undefined);
    const sourceUrl =
      resolveUrl(textValue(parsed.canonicalUrl) ?? textValue(parsed.canonicalPath), store.url) ??
      store.url;
    const originalPrice =
      parseDecimal(numberText(discount.deletedPrice)) ??
      parseDecimal(numberText(price.recommendedPrice));
    const validityEnd = parseDateTime(price.endDate);

    const candidate = buildCandidate({
      storeChain: store.storeChain,
      name: name ?? '',
      brand: isRecord(parsed.brand) ? textValue(parsed.brand.name) : undefined,
      price: parseDecimal(numberText(price.price)),
      originalPrice,
      imageUrl: resolveUrl(image, store.url),
      sourceUrl,
      category:
        textValue(parsed.category) ??
        textValue(parsed.wonCategoryPrimary) ??
        textValue(parsed.listName),
      validityEnd,
      tags: ['filiale'],
    });

    if (candidate) {
      offers.push(candidate);
    }
  }

  return offers;
}

const lidlAltFoodKeywords = [
  'apfel',
  'banane',
  'bauerngurken',
  'bellarom',
  'bier',
  'bohnen',
  'brot',
  'caffe',
  'eistee',
  'fisch',
  'frischkase',
  'fruchtsaft',
  'gemuse',
  'getrank',
  'gurke',
  'joghurt',
  'kaffee',
  'kaese',
  'limonade',
  'milch',
  'paprika',
  'pfanner',
  'saft',
  'schwap',
  'schwip',
  'spitzpaprika',
  'tomate',
  'wein',
  'wurst',
  '7up',
];

const lidlAltNonFoodKeywords = [
  'adidas',
  'aluminium',
  'app',
  'bluse',
  'criv it',
  'crivit',
  'disney',
  'fahrrad',
  'foto',
  'gartentisch',
  'hotel',
  'kaffeevollautomat',
  'kajak',
  'kommode',
  'livarno',
  'mode',
  'raten zahlen',
  'reise',
  'sessel',
  'shirt',
  'shorts',
  'silvercrest',
  'smart tv',
  'smartphone',
  'stadion tour',
  'stuhl',
  't-shirt',
  'ticket',
  'versandkosten',
  'wohnen',
];

function isLikelyLidlFoodAlt(altText: string): boolean {
  const normalized = normalizeText(altText);
  if (containsNormalized(normalized, lidlAltNonFoodKeywords)) {
    return false;
  }

  return containsNormalized(normalized, lidlAltFoodKeywords);
}

function parseLidlAltName(altText: string, priceIndex: number): string {
  const beforePrice = altText
    .slice(0, priceIndex)
    .replace(/\s+-\d+\s*%.*$/i, '')
    .trim();
  const withoutMarketingDash = beforePrice.replace(/^.*?\s+[–-]\s+/i, '');
  const marketingPrefix = withoutMarketingDash.match(/^([^:]{1,80}):\s*(.+)$/);
  const withoutPrefix =
    withoutMarketingDash === beforePrice && marketingPrefix && !marketingPrefix[1].includes(',')
      ? marketingPrefix[2]
      : withoutMarketingDash;
  const withoutOfferDetails = withoutPrefix
    .replace(/\b\d+\s*(?:cent|ct|euro|\u20ac|â‚¬)\s+g(?:\u00fc|Ã¼|ue|ÃƒÂ¼)nstiger.*$/i, '')
    .replace(/\bje\s+[\d.,]+\s*(?:kg|g|l|ml|cl|stk|st(?:\u00fc|Ã¼|ue|ÃƒÂ¼)ck)\b.*$/i, '')
    .trim();
  const firstSegment = withoutOfferDetails.split(',')[0]?.trim() ?? withoutOfferDetails;
  return firstSegment.replace(/^nur\s+/i, '').replace(/\.\s*$/, '').trim();
}

function parseLidlImageAltOffers(
  html: string,
  store: OfficialStoreConfig,
): RawOfferCandidate[] {
  const offers: RawOfferCandidate[] = [];
  const imageTags = html.matchAll(/<img\b[^>]*>/gi);

  for (const imageTag of imageTags) {
    const tag = imageTag[0];
    const altText = getAttribute(tag, 'alt');
    if (!altText || !isLikelyLidlFoodAlt(altText)) {
      continue;
    }

    const priceMatch =
      /\b(?:f(?:\u00fc|ü|ue|Ã¼)r(?:\s+nur)?|nur|ab|online\s+f(?:\u00fc|ü|ue|Ã¼)r)\s*([\d]+(?:[,.]\d{2}|[,.]-)?)\s*(?:\u20ac|€|EUR|â‚¬)?/i.exec(
        altText,
      );
    if (!priceMatch || typeof priceMatch.index !== 'number') {
      continue;
    }

    const name = parseLidlAltName(altText, priceMatch.index);
    const unit =
      altText.match(/\bje\s+([\d.,]+\s*(?:kg|g|l|ml|cl|stk|stueck|stück))\b/i)?.[1] ??
      undefined;
    const baseParts = parseBasePriceText(
      altText.match(/\(([^()]+?=\s*[\d.,-]+\s*(?:\u20ac|€|EUR|â‚¬)?)\)/i)?.[1],
    );
    const imageUrl = resolveUrl(
      getAttribute(tag, 'data-src') ?? getAttribute(tag, 'src'),
      store.url,
    );

    const candidate = buildCandidate({
      storeChain: store.storeChain,
      name,
      price: parseDecimal(priceMatch[1]),
      unit,
      basePrice: baseParts.basePrice,
      baseUnit: baseParts.baseUnit,
      imageUrl,
      sourceUrl: store.url,
      category: 'Lidl Startseiten-Angebot',
      tags: altText.includes('%') ? ['lidl-teaser', 'reduziert'] : ['lidl-teaser'],
    });

    if (candidate) {
      offers.push(candidate);
    }
  }

  return offers;
}

/** Parse the validity start date out of an `aktionsprospekt-DD-MM-YYYY-…`
 *  identifier (used to sort current week before next week). */
function lidlLeafletIdentifierStartYmd(identifier: string): number | null {
  const match = identifier.match(/^aktionsprospekt-(\d{2})-(\d{2})-(\d{4})-/i);
  if (!match) {
    return null;
  }
  return Number(`${match[3]}${match[2]}${match[1]}`);
}

/**
 * Permanenter Identifier des laufenden Lidl-Aktionsprospekts. Anders als die
 * datierten `aktionsprospekt-DD-MM-YYYY-…`-Slugs wechselt er NIE — der
 * Flyer-Endpoint löst ihn immer auf den aktuell laufenden Prospekt auf.
 *
 * Historisch galten `latest-leaflet-…`-Ids als leere Teaser (0 Produkte) und
 * wurden deshalb aktiv gemieden. Das ist nachweislich überholt: am 2026-08-17
 * lieferte dieser Identifier den vollständigen „Aktionsprospekt 17.08.–22.08."
 * mit 72 Seiten, 236 Hotspots und 180 Produkten — identisch zum datierten Slug
 * derselben Woche. Er dient hier als verlässlicher Fallback, damit ein
 * geändertes Discovery-HTML den Lidl-Wochenscan nicht mehr auf 0 fallen lässt.
 */
export const LIDL_LATEST_LEAFLET_IDENTIFIER =
  'latest-leaflet-f5771509-f19a-11e9-b196-005056ab0fb6';

/**
 * Endgültige Prospektliste EINES Lidl-Scans: der permanente Identifier ist
 * GESETZT, nicht mehr nur Notnagel.
 *
 * Grund: die datierten `aktionsprospekt-…`-Slugs stammen aus einer Regex auf der
 * Prospekt-HTML-Seite und hängen damit an Lidls Markup. Der permanente
 * Identifier wird serverseitig aufgelöst und ist genau der, den auch die
 * Viewer-App abruft (im Browser mitgeschnitten: er ist ihre EINZIGE
 * Datenanfrage). Er steht deshalb vorn und garantiert die laufende Woche auch
 * dann, wenn die Discovery nichts mehr findet.
 *
 * Die datierten Slugs bleiben dahinter, weil nur sie das erwartete
 * Gültigkeitsfenster für die Subquellen-Diagnose tragen und die FOLGE-Wochen
 * liefern, die der permanente Identifier nicht kennt. Das Limit wächst um
 * genau eins, damit der garantierte Eintrag die nächste Woche nicht verdrängt.
 */
export function resolveLidlLeafletIdentifiers(discovered: readonly string[]): string[] {
  const weitere = discovered.filter(
    (identifier) => identifier !== LIDL_LATEST_LEAFLET_IDENTIFIER,
  );
  return [LIDL_LATEST_LEAFLET_IDENTIFIER, ...weitere].slice(0, LIDL_MAX_LEAFLETS + 1);
}

/** Flyer-Identität aus einem geparsten v4/flyer-JSON — der permanente Identifier
 *  und der datierte Slug der laufenden Woche lösen auf DENSELBEN Flyer auf
 *  (verifiziert: identische `flyer.id`, 71 Seiten, 175 Produkte). */
export function readLidlFlyerId(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const flyer = (parsed as { flyer?: unknown }).flyer;
  if (!flyer || typeof flyer !== 'object') {
    return null;
  }
  const id = (flyer as { id?: unknown }).id;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}

/**
 * Extract ALL weekly Aktionsprospekt identifiers from the Lidl Prospekte page,
 * sorted by start date (current week first). The page usually lists the running
 * week plus 1–2 upcoming weeks.
 *
 * Trägt die Seite zwar Prospekt-Links, aber KEINEN datierten Aktionsprospekt
 * (Lidl hat das Slug-Schema geändert), wird auf den permanenten
 * {@link LIDL_LATEST_LEAFLET_IDENTIFIER} zurückgefallen statt auf einen
 * beliebigen anderen Link der Seite — sonst liest der Wochenscan ein
 * Rezeptemagazin („PAW Patrol") oder den Dauer-Preisführer als Wochenangebote
 * ein. Ein datierter Slug bleibt bevorzugt, weil nur er das erwartete
 * Gültigkeitsfenster für die Subquellen-Diagnose trägt.
 *
 * Findet die Seite ÜBERHAUPT keinen Prospekt-Link, bleibt das Ergebnis leer:
 * Ein unlesbares/leeres Dokument darf keinen Netzwerk-Abruf auslösen, sondern
 * muss als Quellfehler sichtbar werden (`no_leaflet_identifier`).
 */
export function extractLidlLeafletIdentifiers(html: string): string[] {
  const identifiers = [...html.matchAll(/\/l\/prospekte\/([^/"']+)(?:\/(?:ar\/\d+|view\/flyer))?/gi)]
    .map((match) => decodeURIComponent(match[1] ?? '').trim())
    .filter(Boolean);
  const distinct = [...new Set(identifiers)];
  const aktionsprospekte = distinct
    .filter((identifier) => lidlLeafletIdentifierStartYmd(identifier) !== null)
    .sort(
      (a, b) =>
        (lidlLeafletIdentifierStartYmd(a) ?? 0) - (lidlLeafletIdentifierStartYmd(b) ?? 0),
    );
  if (aktionsprospekte.length > 0) {
    return aktionsprospekte;
  }
  if (distinct.length === 0) {
    return [];
  }
  return [LIDL_LATEST_LEAFLET_IDENTIFIER];
}

/** Backwards-compatible single-identifier variant (first = current week). */
function extractLidlLeafletIdentifier(html: string): string | undefined {
  return extractLidlLeafletIdentifiers(html)[0];
}

// Lidl flyer category paths ("Bedürfniswelten/Sport & Freizeit/Wassersport",
// "Kategorien/Weinwelt/…"). Food vs non-food is decided on the CATEGORY PATH —
// never on the product name — so "Hausmacher Wurst" can never be misclassified.
const LIDL_LEAFLET_FOOD_CATEGORY_KEYWORDS = [
  'wein',
  'spirituosen',
  'champagner',
  'sekt',
  'essen',
  'trinken',
  'lebensmittel',
  'getraenke',
  'food',
  'suesswaren',
  'kaffee',
];

const LIDL_LEAFLET_NON_FOOD_CATEGORY_KEYWORDS = [
  'sport',
  'freizeit',
  'wohnen',
  'einrichtung',
  'baumarkt',
  'garten',
  'mode',
  'accessoires',
  'kueche', // "Küche & Haushalt" = Geräte/Geschirr, nicht Lebensmittel
  'haushalt',
  'baby',
  'kind',
  'spielware',
  'spielzeug',
  'technik',
  'multimedia',
  'elektro',
  'auto',
  'werkstatt',
  'werkzeug',
  'camping',
  'outdoor',
  'schlafzimmer',
  'wohnzimmer',
  'badezimmer',
  'dekoration',
  'beleuchtung',
  'bekleidung',
  'schuhe',
  'tierbedarf',
  'heimtier',
];

/**
 * Decide food vs non-food for a Lidl leaflet product from its category path.
 * Food keywords win (so "Weinwelt" stays food even if a future combined path
 * also mentions a non-food segment); unknown paths return false (= unsure, the
 * offer stays visible and Phase 2 / the strict filter decide).
 */
export function isLidlLeafletNonFoodCategory(categoryPath: string | undefined): boolean {
  const normalized = normalizeText(categoryPath ?? '');
  if (!normalized) {
    return false;
  }
  if (LIDL_LEAFLET_FOOD_CATEGORY_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return false;
  }
  return LIDL_LEAFLET_NON_FOOD_CATEGORY_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function parseLidlLeafletProducts(
  value: unknown,
  store: OfficialStoreConfig,
  diagnosticsSink?: { skippedNoImage: number },
): RawOfferCandidate[] {
  const flyer = isRecord(value) && isRecord(value.flyer) ? value.flyer : undefined;
  if (!flyer || !isRecord(flyer.products)) {
    return [];
  }

  const validityStart =
    dateOnlyToIso(textValue(flyer.offerStartDate)) ??
    dateOnlyToIso(textValue(flyer.startDate));
  const validityEnd =
    dateOnlyToIso(textValue(flyer.offerEndDate), true) ??
    dateOnlyToIso(textValue(flyer.endDate), true);
  const offers: RawOfferCandidate[] = [];

  // Import EVERY priced product. Food/non-food is decided per category path:
  // non-food carries the unambiguous "nonfood" tag (→ strict filter routes it
  // to the filtered bucket), food/unknown stays visible. The old food-keyword
  // allowlist silently dropped ~95 % of the flyer and left Lidl with 1 offer.
  for (const productValue of Object.values(flyer.products)) {
    if (!isRecord(productValue)) {
      continue;
    }
    const product = productValue as LidlLeafletProduct;

    const category =
      textValue(product.wonCategoryPrimary) ??
      textValue(product.categoryPrimary) ??
      'Lidl Prospekt';
    const nonFood = isLidlLeafletNonFoodCategory(category);
    const imageUrl = resolveUrl(textValue(product.image), store.url);
    // Ohne Belegbild geht ein strukturiertes Produkt NIE automatisch live —
    // es bleibt dem Review-Import (Hotspots/PDF-Textebene mit Seitenbild)
    // überlassen. Gemessen wird ehrlich (skippedNoImage → Connector-Warnung).
    if (!imageUrl) {
      if (diagnosticsSink) diagnosticsSink.skippedNoImage += 1;
      continue;
    }
    const candidate = buildCandidate({
      storeChain: store.storeChain,
      name: textValue(product.title) ?? '',
      brand: textValue(product.brand),
      price: parseDecimal(numberText(product.price)),
      imageUrl,
      sourceUrl:
        resolveUrl(textValue(product.url) ?? textValue(product.canonicalUrl), store.url) ??
        store.url,
      category,
      validityStart,
      validityEnd,
      tags: nonFood ? ['lidl-prospekt', 'nonfood'] : ['lidl-prospekt'],
    });

    if (candidate) {
      // Validity-aware id: the same product in the current AND the next-week
      // Aktionsprospekt must stay two distinct offers (Kaufland precedent).
      candidate.id = stableOfficialId(
        store.storeChain,
        `${candidate.name}|${validityStart ?? ''}|${validityEnd ?? ''}`,
        store.url,
      );
      offers.push(candidate);
    }
  }

  return offers;
}

/** Ehrliche Bilanz der Viewer-JSON-Hotspots eines Lidl-Prospekts
 *  (flyer.pages[].links[] + products-Map) — DERSELBE öffentliche v4/flyer-Pfad,
 *  den auch der manuelle Prospekt-Import nutzt. Gemessen, nie behauptet:
 *  nur `structuredPricedCandidates` sind automatisch importierbar; preislose
 *  Produkt-Hotspots und Rezept-Links bleiben pending/Diagnose (Preise werden
 *  NIE geraten, nichts davon geht automatisch live). */
export interface LidlViewerHotspotSummary {
  pageCount: number;
  linksFound: number;
  /** Links mit displayType 'product' (die Produktflächen des Prospekts). */
  productHotspots: number;
  /** Produkt-Hotspots, deren products-Map-Eintrag einen plausiblen Preis trägt. */
  structuredPricedCandidates: number;
  /** Produkt-Hotspots OHNE strukturierten Preis — bleiben pending, nie live. */
  pricelessProductHotspots: number;
  /** Rezept-Links (Titel = Zutat, nie ein Angebot mit Preis). */
  recipeLinks: number;
  /** App-/Aktions-/Serviceflächen (displayType 'standard'). */
  standardLinks: number;
}

/** Zählt die Viewer-JSON-Hotspots eines geparsten v4/flyer-JSON tolerant aus.
 *  Rein strukturell (displayType + products-Map-Preis), keine Namens-/Marken-
 *  Heuristik, keine KW-Logik. Ein fehlendes/kaputtes JSON ergibt eine 0-Bilanz. */
export function summarizeLidlViewerHotspots(value: unknown): LidlViewerHotspotSummary {
  const summary: LidlViewerHotspotSummary = {
    pageCount: 0,
    linksFound: 0,
    productHotspots: 0,
    structuredPricedCandidates: 0,
    pricelessProductHotspots: 0,
    recipeLinks: 0,
    standardLinks: 0,
  };
  const flyer = isRecord(value) && isRecord(value.flyer) ? value.flyer : isRecord(value) ? value : undefined;
  if (!flyer || !Array.isArray(flyer.pages)) {
    return summary;
  }
  const products = isRecord(flyer.products) ? flyer.products : {};
  const pricedLinkIds = new Set<string>();
  for (const [linkId, productValue] of Object.entries(products)) {
    if (!isRecord(productValue)) continue;
    const price = parseDecimal(numberText((productValue as LidlLeafletProduct).price));
    if (price !== undefined && price > 0) pricedLinkIds.add(linkId);
  }
  for (const pageValue of flyer.pages) {
    if (!isRecord(pageValue)) continue;
    summary.pageCount += 1;
    const links = Array.isArray(pageValue.links) ? pageValue.links : [];
    for (const linkValue of links) {
      if (!isRecord(linkValue)) continue;
      summary.linksFound += 1;
      const displayType = String(linkValue.displayType ?? '').toLowerCase();
      if (displayType === 'product') {
        summary.productHotspots += 1;
        const linkId = typeof linkValue.id === 'string' ? linkValue.id : String(linkValue.id ?? '');
        if (linkId && pricedLinkIds.has(linkId)) summary.structuredPricedCandidates += 1;
        else summary.pricelessProductHotspots += 1;
      } else if (displayType === 'recipe') {
        summary.recipeLinks += 1;
      } else if (displayType === 'standard') {
        summary.standardLinks += 1;
      }
    }
  }
  return summary;
}

/** Baut die Report-Bilanzzeile der Viewer-Hotspots EINES Prospekts (Subquelle
 *  `<sourceId>:viewer_hotspots`). Status ist IMMER 'empty' (die Zeile trägt 0
 *  Angebote — die strukturierten Produkte bilanziert die Produktzeile), sie kann
 *  also nie einen Commit blockieren und nie etwas live schalten. null, wenn der
 *  Flyer gar keine Links trägt (kein leeres Rauschen). */
export function buildLidlViewerHotspotDiagnostic(input: {
  store: OfficialStoreConfig;
  identifier: string;
  sourceId: string;
  summary: LidlViewerHotspotSummary;
  expectedValidityStart?: string;
  expectedValidityEnd?: string;
}): SubSourceDiagnostic | null {
  const s = input.summary;
  if (s.linksFound === 0) return null;
  return buildSubSourceDiagnostic({
    storeChain: input.store.storeChain,
    sourceId: `${input.sourceId}:viewer_hotspots`,
    status: 'empty',
    urlOrSlug: input.identifier,
    expectedValidityStart: input.expectedValidityStart,
    expectedValidityEnd: input.expectedValidityEnd,
    rawCount: s.linksFound,
    resultCount: 0,
    note:
      `Viewer-JSON-Hotspots: ${s.pageCount} Seiten, ${s.linksFound} Links, ` +
      `${s.productHotspots} Produkt-Hotspots (${s.structuredPricedCandidates} mit strukturiertem Preis importierbar), ` +
      `${s.pricelessProductHotspots} preislose Produkt-Hotspots + ${s.recipeLinks} Rezept-Links bleiben pending ` +
      `(nie automatisch live, Preise werden nie geraten); ${s.standardLinks} Service-Links ignoriert.`,
  });
}

/** Strukturierter Beleg, dass ein Lidl-Prospekt Bild-SEITEN trägt, deren Inhalt
 *  NICHT als strukturierte Produkte verfügbar ist (die Frische-/Lebensmittel-
 *  angebote). Genau diese Seiten sind die OCR-Kandidaten — gemessen, nicht
 *  behauptet. */
export interface LidlProspectPageEvidence {
  /** Anzahl Prospekt-Bildseiten im Flyer-JSON (flyer.pages). */
  pageCount: number;
  /** Anzahl referenzierter Seiten-Bildassets (Renditions). */
  imageCount: number;
  /** Wenige Beispiel-Bild-URLs als Beleg (nie riesige Listen). */
  imageExamples: string[];
  /** Begrenzte Liste der Prospekt-Bild-URLs (regulär öffentliche CDN-Assets) für
   *  den OCR-Pfad — gedeckelt, damit ein riesiges JSON die Diagnose nicht
   *  aufbläht. */
  imageUrls: string[];
}

/** Obergrenze der für den OCR-Pfad gesammelten Prospekt-Bild-URLs. */
const LIDL_PROSPECT_OCR_URL_CAP = 24;

/** Absolute http(s)-URL mit einer Bild-Endung irgendwo in Pfad/Query (greift
 *  UNABHÄNGIG vom Feldnamen — der klassische, eindeutige Fall). */
const PROSPECT_PAGE_IMAGE_URL =
  /https?:\/\/[^\s"']+\.(?:jpe?g|png|webp|avif|gif)(?:$|[?#/][^\s"']*)?/i;

/** Strukturfelder (NICHT Produktwissen!), deren String-Werte in den diversen
 *  flyer.pages-Layouts eine Bild-/Rendition-URL tragen — shape-tolerant inkl.
 *  gängiger Plurale. Bewusst breit, weil die Schwarz/Lidl-Leaflet-Form je nach
 *  Version url/src/href/image/imageUrl/imageList/renditions/media/variants/assets
 *  nutzt. Kein KW, keine Marke, keine Produktliste. Bewusst NICHT enthalten:
 *  generische Navigations-/Pfadfelder `links`/`paths` — sie tragen Seiten-/Deep-
 *  Links (z. B. das Prospekt-`self`), KEINE Bildassets, und blähten den Bild-URL-
 *  Beleg mit Nicht-Bild-URLs auf. Echte Bildassets liegen unter
 *  image/src/media/renditions/variants/assets. */
const PROSPECT_IMAGE_KEY =
  /^(?:urls?|srcs?|srcset|hrefs?|images?|imagelist|imageurls?|imagesrc|imagelinks?|imgs?|pictures?|photos?|thumbnails?|thumbs?|renditions?|media|assets?|variants?|sources?|files?)$/i;

/** Ressourcen-Endungen, die NIE OCR-Bildseiten sind — hält „nur echte Bild-URLs"
 *  ein, auch wenn der Wert unter einem Bildfeld steht (z. B. JSON-/API-Links). */
const NON_IMAGE_URL = /\.(?:json|html?|xml|js|css|pdf|mp4|webm|svg|ico)(?:$|[?#])/i;

/** True, wenn `value` eine echte, OCR-fähige Bild-URL ist: entweder mit Bild-
 *  Endung (eindeutig), oder eine absolute http(s)-URL unter einem Bildfeld, die
 *  KEINE Nicht-Bild-Ressource ist. So werden auch endungslose CDN-Rendition-URLs
 *  (z. B. `…/render/abc?w=1080`) erfasst — ohne Produktdaten zu erfinden. */
function isProspectImageUrl(value: string, underImageKey: boolean): boolean {
  const url = value.trim();
  if (!/^https?:\/\//i.test(url)) {
    return false;
  }
  if (PROSPECT_PAGE_IMAGE_URL.test(url)) {
    return true;
  }
  return underImageKey && !NON_IMAGE_URL.test(url);
}

/** Sammelt rekursiv Bild-URLs aus einem Prospekt-Seitenobjekt (shape-tolerant:
 *  die Renditions liegen je nach Layout verschachtelt und teils endungslos unter
 *  Bildfeldern). `underImageKey` wird vererbt, sobald man in ein Bildfeld
 *  absteigt (z. B. `media: [{ src }]`). Begrenzt, damit ein riesiges JSON die
 *  Diagnose nicht aufbläht. */
function collectProspectImageUrls(
  value: unknown,
  out: Set<string>,
  underImageKey = false,
  limit = 2000,
): void {
  if (out.size >= limit) {
    return;
  }
  if (typeof value === 'string') {
    if (isProspectImageUrl(value, underImageKey)) {
      out.add(value.trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectProspectImageUrls(entry, out, underImageKey, limit);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectProspectImageUrls(child, out, underImageKey || PROSPECT_IMAGE_KEY.test(key), limit);
    }
  }
}

/**
 * Erkennt die Prospekt-Bildseiten eines Lidl-Flyer-JSON (`flyer.pages`/
 * `flyer.pageList`) und zählt Seiten + Bildassets. Rein strukturell + generisch:
 * KEINE Produktliste, kein Keyword — nur "wie viele Bildseiten trägt der
 * Prospekt, die strukturell nicht als Produkte vorliegen". Das ist der ehrliche
 * Beleg für den OCR-Bedarf (Frische-/Lebensmittelseiten existieren nur als
 * Bilder).
 */
export function detectLidlProspectPages(value: unknown): LidlProspectPageEvidence {
  const flyer = isRecord(value) && isRecord(value.flyer) ? value.flyer : undefined;
  const pagesValue = flyer ? flyer.pages ?? flyer.pageList : undefined;
  const pages = Array.isArray(pagesValue) ? pagesValue : [];
  const images = new Set<string>();
  for (const page of pages) {
    collectProspectImageUrls(page, images);
  }
  // Stabil partitionieren: eindeutige Bild-Endungs-URLs ZUERST, dann die
  // endungslosen (unter Bildfeldern akzeptierten) CDN-Rendition-URLs. So trifft
  // das begrenzte OCR-Budget (URL-Cap → imageLimit) zuerst die klar renderbaren
  // Bildseiten und verschwendet keinen Versuch an ambivalente endungslose Links.
  // Rein strukturell (Endungs-Match) — kein Produkt-/Markenwissen.
  const all = [...images];
  const withExtension = all.filter((url) => PROSPECT_PAGE_IMAGE_URL.test(url));
  const withoutExtension = all.filter((url) => !PROSPECT_PAGE_IMAGE_URL.test(url));
  const ordered = [...withExtension, ...withoutExtension];
  return {
    pageCount: pages.length,
    imageCount: images.size,
    imageExamples: ordered.slice(0, 4),
    imageUrls: ordered.slice(0, LIDL_PROSPECT_OCR_URL_CAP),
  };
}

function extractNahkaufStoryblokToken(html: string): string | undefined {
  return html.match(/storyblok:\s*\{[^}]*accessToken:\s*"([^"]+)"/i)?.[1];
}

function nahkaufFeatureValue(content: NahkaufOfferContent, key: string): string | undefined {
  if (!Array.isArray(content.features)) {
    return undefined;
  }
  const feature = content.features.find(
    (value) => isRecord(value) && textValue(value.key)?.toLowerCase() === key.toLowerCase(),
  );
  return isRecord(feature) ? textValue(feature.value) : undefined;
}

function parseNahkaufCentPrice(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Number((value / 100).toFixed(2));
  }
  return parseDecimal(numberText(value));
}

function parseNahkaufImageUrl(content: NahkaufOfferContent): string | undefined {
  if (!Array.isArray(content.images)) {
    return undefined;
  }
  for (const image of content.images) {
    if (!isRecord(image)) {
      continue;
    }
    const url = textValue(image.image_url);
    if (url) {
      return url.trim();
    }
  }
  return undefined;
}

/** Does the offer's market list contain the configured market id? */
function nahkaufOfferMatchesMarket(content: NahkaufOfferContent, marketId: string): boolean {
  if (!marketId) {
    return false;
  }
  if (Array.isArray(content.market_ids_array)) {
    if (content.market_ids_array.some((value) => String(value).trim() === marketId)) {
      return true;
    }
  }
  const csv = textValue(content.market_ids);
  if (csv) {
    return csv.split(',').some((value) => value.trim() === marketId);
  }
  return false;
}

function parseNahkaufStoryOffer(
  story: NahkaufStory,
  store: OfficialStoreConfig,
  options: { marketId?: string } = {},
): RawOfferCandidate | null {
  if (!isRecord(story.content)) {
    return null;
  }
  const content = story.content as NahkaufOfferContent;
  // Without a selected market we must not import arbitrary local-only offers.
  // National offers are shown by the site even before market selection; with a
  // configured NAHKAUF_MARKET_ID the market's local offers are included too.
  const marketId = (options.marketId ?? '').trim();
  const matchesMarket = marketId.length > 0 && nahkaufOfferMatchesMarket(content, marketId);
  if (content.national_all !== true && !matchesMarket) {
    return null;
  }
  // Ehrlicher Quell-Scope: national_all-Angebote bleiben 'national'; alles
  // andere wurde NUR wegen des Markt-Matches importiert und ist damit ein
  // lokales Marktangebot — Tag + sourceScope tragen den Marktbezug durch die
  // Pipeline (der Report verifiziert daran den marktbezogenen Import).
  const isNational = content.national_all === true;

  const baseParts = parseBasePriceText(textValue(content.base_price));
  return buildCandidate({
    storeChain: store.storeChain,
    name: textValue(content.advertising_product_name) ?? '',
    brand: textValue(content.brand),
    price: parseNahkaufCentPrice(content.promotion_price),
    originalPrice: parseNahkaufCentPrice(content.cross_out_price),
    unit: textValue(content.amount),
    basePrice: baseParts.basePrice,
    baseUnit: baseParts.baseUnit,
    imageUrl: parseNahkaufImageUrl(content),
    sourceUrl: resolveUrl(String(story.full_slug ?? ''), 'https://www.nahkauf.de/') ?? store.url,
    category:
      nahkaufFeatureValue(content, 'NAHKAUF_CATEGORY') ??
      nahkaufFeatureValue(content, 'REWE_CATEGORY') ??
      'nahkauf Angebot',
    validityStart:
      dateOnlyToIso(textValue(content.valid_from)) ??
      dateOnlyToIso(nahkaufFeatureValue(content, 'advertFrom')),
    validityEnd:
      dateOnlyToIso(textValue(content.valid_to), true) ??
      dateOnlyToIso(nahkaufFeatureValue(content, 'advertTo'), true),
    sourceScope: isNational ? 'national' : 'local',
    tags: ['nahkauf-storyblok', isNational ? 'national' : NAHKAUF_LOCAL_OFFER_TAG],
  });
}

function parseNahkaufStoryblokOffers(
  value: unknown,
  store: OfficialStoreConfig,
  options: { marketId?: string } = {},
): RawOfferCandidate[] {
  const stories = isRecord(value) && Array.isArray(value.stories) ? value.stories : [];
  return stories
    .filter(isRecord)
    .map((story) => parseNahkaufStoryOffer(story as NahkaufStory, store, options))
    .filter((offer): offer is RawOfferCandidate => Boolean(offer));
}

/**
 * nahkauf-Dedupe: nationale und lokale Stories können dasselbe Produkt doppelt
 * liefern (gleicher Name/Preis/Gültigkeit, unterschiedliche Story-Slugs → die
 * Id-Dedupe greift nicht). Nach der Id-Dedupe wird deshalb zusätzlich
 * inhaltlich dedupliziert; die Scope-Tags (national/nahkauf-local) beider
 * Duplikate bleiben dabei erhalten.
 */
function dedupeNahkaufOffers(offers: RawOfferCandidate[]): RawOfferCandidate[] {
  const byContent = new Map<string, RawOfferCandidate>();
  for (const offer of dedupeOffersById(offers)) {
    const key = [
      offer.name.trim().toLowerCase(),
      offer.price ?? '',
      offer.validityStart ?? '',
      offer.validityEnd ?? '',
    ].join('|');
    const existing = byContent.get(key);
    if (!existing) {
      byContent.set(key, offer);
      continue;
    }
    byContent.set(key, {
      ...existing,
      tags: [...new Set([...(existing.tags ?? []), ...(offer.tags ?? [])])],
    });
  }
  return [...byContent.values()];
}

// Storyblok caps per_page at 100; 593 offer stories ≈ 6 pages. The hard page
// ceiling keeps a runaway/looping API from stalling the whole scan.
const NAHKAUF_STORYBLOK_PER_PAGE = 100;
const NAHKAUF_STORYBLOK_MAX_PAGES = 12;

// Die nahkauf-Angebotsseite kann komplett entfallen (Stand 2026-07: 404, der
// „Angebote"-Link der Seite zeigt auf rewe.de). Der öffentliche Storyblok-Token
// liegt weiterhin im HTML der Startseite — deshalb Fallback statt Store-
// Fehlschlag: so kann die Diagnose ehrlich „0 Offer-Stories" statt nur „Seite
// nicht erreichbar" sagen, und der Import erholt sich automatisch, sobald
// nahkauf wieder eigene Angebote publiziert.
const NAHKAUF_HOME_URL = 'https://www.nahkauf.de/';

/** Strukturierte nahkauf-Import-Diagnose des letzten Laufs (analog EDEKA/ALDI):
 *  wird beim Scrape gesetzt und vom Scan-Report gelesen, ohne erneut zu fetchen.
 *  Trägt insbesondere den belegten source-gap (Storyblok-Space ganz ohne
 *  Offer-Stories + „Angebote"-Link auf rewe.de), damit der Health-Report 0
 *  nahkauf-Angebote NICHT als critical-Defekt eskaliert. */
export interface NahkaufImportDiagnostics {
  generatedAt: string;
  sourceUrl: string;
  /** 'offers_page' = reguläre Angebotsseite geladen; 'home_fallback' = Token von
   *  der Startseite gelesen (Angebotsseite nicht erreichbar/404). */
  pageSource: 'offers_page' | 'home_fallback';
  /** true nur, wenn WEDER Angebotsseite NOCH Startseite lesbar waren. */
  blocked: boolean;
  blockReason?: string;
  /** Öffentlicher Storyblok-Token im geladenen HTML gefunden? */
  tokenFound: boolean;
  /** Offer-Stories aus der Storyblok-CDN-API (VOR Markt-/national-Filter). */
  offerStoryCount: number;
  /** Importierte (deduplizierte) Angebote. */
  importedDistinct: number;
  /** „Angebote"-Link der geladenen Seite zeigt auf rewe.de. */
  offersLinkToRewe: boolean;
  /** Belegter source-gap: 0 Offer-Stories UND Angebote-Link auf rewe.de —
   *  nahkauf publiziert derzeit keine eigenen Online-Angebote. Kein Defekt. */
  sourceGap: boolean;
  marketIdConfigured: boolean;
  /** Letzter Lauf mit ≥ 1 importierten Angebot (über Prozess-Laufzeit erhalten). */
  lastSuccessfulAt?: string;
}

let lastNahkaufDiagnostics: NahkaufImportDiagnostics | null = null;
// Von fetchNahkaufHtmlWithFallback gesetzt, von fetchNahkaufOffers gelesen —
// gleiche Modul-Last-State-Konvention wie lastEdekaDiagnostics.
let lastNahkaufPageSource: NahkaufImportDiagnostics['pageSource'] = 'offers_page';

export function getLastNahkaufDiagnostics(): NahkaufImportDiagnostics | null {
  return lastNahkaufDiagnostics;
}

/** Block-/Fehlerdiagnose setzen, wenn für nahkauf WEDER Angebotsseite noch
 *  Startseite lesbar war (Timeout/Netzfehler) — damit der Report die Lage
 *  ehrlich als blocked zeigt, statt den Store verschwinden zu lassen. */
function recordNahkaufFetchFailure(store: OfficialStoreConfig, error: unknown): void {
  const message = error instanceof Error ? error.message : 'unbekannter Fehler';
  lastNahkaufDiagnostics = {
    generatedAt: new Date().toISOString(),
    sourceUrl: store.url,
    pageSource: 'offers_page',
    blocked: true,
    blockReason: message,
    tokenFound: false,
    offerStoryCount: 0,
    importedDistinct: 0,
    offersLinkToRewe: false,
    sourceGap: false,
    marketIdConfigured: appConfig.nahkaufMarketId.trim().length > 0,
    lastSuccessfulAt: lastNahkaufDiagnostics?.lastSuccessfulAt,
  };
}

async function fetchNahkaufHtmlWithFallback(
  store: OfficialStoreConfig,
  warnings: string[],
): Promise<string> {
  let pageError: unknown;
  try {
    const html = await fetchOfficialHtml(store);
    lastNahkaufPageSource = 'offers_page';
    return html;
  } catch (error) {
    pageError = error;
  }
  const reason = pageError instanceof Error ? pageError.message : 'unbekannter Fehler';
  try {
    const html = await fetchOfficialText(NAHKAUF_HOME_URL, {
      accept: 'text/html,application/xhtml+xml',
    });
    lastNahkaufPageSource = 'home_fallback';
    warnings.push(
      `${store.storeChain}: Angebotsseite nicht erreichbar (${reason}) — Storyblok-Token stattdessen von der Startseite gelesen.`,
    );
    return html;
  } catch {
    // Auch die Startseite ist weg: ehrlich am ursprünglichen Fehler festhalten.
    throw pageError instanceof Error ? pageError : new Error(reason);
  }
}

/** True, wenn die geladene nahkauf-Seite ihre „Angebote" auf rewe.de verlinkt.
 *  Zusammen mit 0 Offer-Stories ist das der Beleg, dass nahkauf derzeit keine
 *  eigenen Online-Angebote publiziert (source-gap), kein Parser-Defekt. */
function nahkaufOffersLinkToRewe(html: string): boolean {
  return /href="https?:\/\/www\.rewe\.de\/angebote[^"]*"/i.test(html);
}

/** Ehrliche 0-Angebote-Warnung: unterscheidet den belegten Source-Gap (Space
 *  ganz ohne Offer-Stories + Angebote-Link auf rewe.de) von einer falschen
 *  Markt-ID bzw. dem erwartbaren national-only-Import. Pure + testbar. */
function buildNahkaufZeroOffersWarning(
  store: OfficialStoreConfig,
  marketId: string,
  html: string,
  storyCount: number,
): string {
  if (storyCount === 0 && nahkaufOffersLinkToRewe(html)) {
    return (
      `${store.storeChain}: 0 Offer-Stories in Storyblok und die nahkauf-Seite verlinkt ` +
      '„Angebote" auf rewe.de — nahkauf publiziert derzeit keine eigenen Online-Angebote ' +
      '(source-gap, kein Parser-Defekt). Nächste Aktion: keine — Import erholt sich ' +
      'automatisch, sobald wieder Offer-Stories vorhanden sind.'
    );
  }
  return marketId
    ? `${store.storeChain}: 0 Angebote für Markt ${marketId} — Markt-ID prüfen.`
    : `${store.storeChain}: 0 nationale Angebote aus Storyblok — ohne NAHKAUF_MARKET_ID werden nur nationale Angebote importiert.`;
}

/**
 * Fetch the nahkauf offers from the public Storyblok CDN API the site itself
 * uses (`angebote-im-markt` page → accessToken → `content_type=offer` stories).
 * `html` may also be the Startseite (Fallback, wenn die Angebotsseite 404 ist —
 * der Token liegt dort im selben Format). robots.txt does not block the page,
 * the token is served publicly in the page HTML, and the API is an
 * unauthenticated CDN read — no captcha/anti-bot bypass involved. Without a
 * NAHKAUF_MARKET_ID only national offers are imported.
 */
async function fetchNahkaufOffers(
  html: string,
  store: OfficialStoreConfig,
  warnings: string[],
): Promise<RawOfferCandidate[]> {
  const token = extractNahkaufStoryblokToken(html);
  if (!token) {
    warnings.push(
      `${store.storeChain}: Storyblok-Token nicht in der Angebotsseite gefunden — Quelle blockiert oder Seitenformat geändert.`,
    );
    lastNahkaufDiagnostics = {
      generatedAt: new Date().toISOString(),
      sourceUrl: store.url,
      pageSource: lastNahkaufPageSource,
      blocked: false,
      tokenFound: false,
      offerStoryCount: 0,
      importedDistinct: 0,
      offersLinkToRewe: nahkaufOffersLinkToRewe(html),
      sourceGap: false,
      marketIdConfigured: appConfig.nahkaufMarketId.trim().length > 0,
      lastSuccessfulAt: lastNahkaufDiagnostics?.lastSuccessfulAt,
    };
    return [];
  }

  const marketId = appConfig.nahkaufMarketId.trim();
  const offers: RawOfferCandidate[] = [];
  let storyCount = 0;
  for (let page = 1; page <= NAHKAUF_STORYBLOK_MAX_PAGES; page += 1) {
    const url =
      `https://api.storyblok.com/v2/cdn/stories?token=${encodeURIComponent(token)}` +
      `&content_type=offer&version=published&per_page=${NAHKAUF_STORYBLOK_PER_PAGE}&page=${page}`;
    let stories: unknown[] = [];
    try {
      const jsonText = await fetchOfficialText(url, {
        accept: 'application/json,text/plain,*/*',
        referer: store.url,
        timeoutMs: Math.max(appConfig.officialOffersTimeoutMs, 30000),
      });
      const parsed = JSON.parse(jsonText) as { stories?: unknown[] };
      stories = Array.isArray(parsed.stories) ? parsed.stories : [];
    } catch (error) {
      warnings.push(
        `${store.storeChain}: Storyblok-Angebote (Seite ${page}) konnten nicht gelesen werden (${
          error instanceof Error ? error.message : 'unbekannter Fehler'
        }).`,
      );
      break;
    }
    storyCount += stories.length;
    offers.push(...parseNahkaufStoryblokOffers({ stories }, store, { marketId }));
    if (stories.length < NAHKAUF_STORYBLOK_PER_PAGE) {
      break;
    }
  }

  if (offers.length === 0) {
    warnings.push(buildNahkaufZeroOffersWarning(store, marketId, html, storyCount));
  }

  const deduped = dedupeNahkaufOffers(offers);
  if (
    marketId &&
    deduped.length > 0 &&
    !deduped.some((offer) => (offer.tags ?? []).includes(NAHKAUF_LOCAL_OFFER_TAG))
  ) {
    warnings.push(
      `${store.storeChain}: Markt ${marketId} konfiguriert, aber keine lokalen Marktangebote gefunden — nur nationale Angebote importiert (Markt-ID prüfen).`,
    );
  }
  // Strukturierte Diagnose für den Scan-Report (analog EDEKA): trägt den
  // belegten source-gap, damit 0 nahkauf-Angebote nie als critical eskalieren.
  const offersLinkToRewe = nahkaufOffersLinkToRewe(html);
  lastNahkaufDiagnostics = {
    generatedAt: new Date().toISOString(),
    sourceUrl: store.url,
    pageSource: lastNahkaufPageSource,
    blocked: false,
    tokenFound: true,
    offerStoryCount: storyCount,
    importedDistinct: deduped.length,
    offersLinkToRewe,
    sourceGap: storyCount === 0 && offersLinkToRewe,
    marketIdConfigured: marketId.length > 0,
    lastSuccessfulAt:
      deduped.length > 0
        ? new Date().toISOString()
        : lastNahkaufDiagnostics?.lastSuccessfulAt,
  };
  return deduped;
}

// \u2500\u2500 EDEKA (Template "edeka_neu") \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Bis Mitte 2026 lieferte https://www.edeka.de/angebote ein Next.js
// __NEXT_DATA__-JSON mit st_text-Teasern. Die Seite ist inzwischen rein
// serverseitig gerendertes HTML (Template "edeka_neu"): kein __NEXT_DATA__ mehr,
// jedes Angebot ist eine <dialog id="dialog-angebot-UUID">-Karte mit
// MASCHINENLESBAREN sr-only Preis-Labels ("Festpreis von X \u20ac", "App-Preis von
// X \u20ac", "Rabattierter Preis von X \u20ac"). Der alte Parser fand deshalb 0 Teaser
// \u2192 0 Angebote (Root Cause des leeren Imports). Dieser Parser liest die Karten
// strukturiert und trennt Angebotspreis, App-/Bonuspreis, Normalpreis und
// Grundpreis sauber.
//
// Die /angebote-Seite zeigt OHNE Marktauswahl ausschlie\u00dflich die NATIONALEN
// Angebote (Header id="national-offers-header", page_market_id leer). Lokale/
// regionale Angebote br\u00e4uchten eine Marktauswahl (nur im Browser) \u2014 der
// automatische Import bleibt deshalb ehrlich `national_only`, niemals `full`.

const EDEKA_OFFER_IMAGE_HOST = 'offer-images.api.edeka';

/** Maschinenlesbarer Ablehnungsgrund f\u00fcr ein EDEKA-Angebot (Z\u00e4hlkette). */
export type EdekaRejectReason = 'kein_name' | 'kein_angebotspreis' | 'kein_preis';

export interface EdekaImportDiagnostics {
  generatedAt: string;
  sourceUrl: string;
  /** Quelle ist eine Block-/Anti-Bot-/Fehlerseite (keine Angebote erreichbar). */
  blocked: boolean;
  blockReason?: string;
  /** HTTP-Status, falls bekannt (vom Fetch gesetzt; 200 bei Block-200-Seite). */
  httpStatus?: number;
  /** Sieht die Seite \u00fcberhaupt nach der Angebots-Struktur aus? false + 0 Bl\u00f6cke
   *  \u21d2 Layout ge\u00e4ndert / Parser-Verdacht statt "ehrlich leer". */
  pageLooksLikeOffers: boolean;
  /** Marktbezug der gelesenen Angebote. */
  marketScope: 'national' | 'local' | 'none';
  // \u2500\u2500 Z\u00e4hlkette: Quelle \u2192 Bl\u00f6cke \u2192 Kandidaten \u2192 importiert \u2192 Dubletten \u2500\u2500\u2500\u2500\u2500\u2500
  offerBlocks: number;
  candidates: number;
  /** Kandidaten mit g\u00fcltigem Angebotspreis (vor Dedupe). */
  withOfferPrice: number;
  importedDistinct: number;
  duplicatesMerged: number;
  rejectedByReason: Record<EdekaRejectReason, number>;
  rejectedExamples: string[];
  /** Karten ohne brauchbares Produktbild (offer-images-Host). */
  brokenImageCount: number;
  /** Zeitpunkt des letzten Laufs in diesem Prozess, der \u22651 Angebot lieferte. */
  lastSuccessfulAt?: string;
  /** Fr\u00fchestes gesehenes "G\u00fcltig ab" (Diagnose: aktuelle vs. n\u00e4chste Woche). */
  validityStartSeen?: string;
}

function emptyEdekaRejections(): Record<EdekaRejectReason, number> {
  return { kein_name: 0, kein_angebotspreis: 0, kein_preis: 0 };
}

/** sr-only-Labels (Screenreader-Texte) einer EDEKA-Karte \u2014 die maschinenlesbare
 *  Preis-Wahrheit der Seite. */
function edekaSrOnlyLabels(block: string): string[] {
  return [
    ...block.matchAll(
      /<(?:div|span)[^>]*class="[^"]*\bsr-only\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/gi,
    ),
  ]
    .map((match) => stripHtml(match[1]))
    .filter((label) => label.length > 0);
}

function edekaPriceFromLabels(
  labels: string[],
  pattern: RegExp,
): number | undefined {
  for (const label of labels) {
    const match = label.match(pattern);
    if (match) {
      return parseDecimal(match[1]);
    }
  }
  return undefined;
}

/** "G\u00fcltig ab DD.MM.YYYY" / "G\u00fcltig bis DD.MM.YYYY" \u2192 ISO-Fenster. EDEKA-
 *  Wochenangebote laufen ab dem genannten Montag bis Samstag (6 Tage). */
function parseEdekaValidity(block: string): { start?: string; end?: string } {
  const text = stripHtml(block);
  const toIso = (raw: string | undefined, endOfDay = false): string | undefined => {
    const m = raw?.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (!m) {
      return undefined;
    }
    return dateOnlyToIso(
      `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`,
      endOfDay,
    );
  };
  const start = toIso(text.match(/G[\u00fcu]ltig\s+ab\s+([\d.]+)/i)?.[1]);
  const explicitEnd = toIso(text.match(/G[\u00fcu]ltig\s+bis\s+([\d.]+)/i)?.[1], true);
  const end = explicitEnd ?? (start ? addDaysIso(start, 5, true) : undefined);
  return { start, end };
}

/** Produktbild einer Karte: das gro\u00df gerenderte offer-images-Bild (nicht die
 *  kleinen Marken-/Siegel-Logos). */
function edekaCardImage(block: string, baseUrl: string): string | undefined {
  const imgs = [
    ...block.matchAll(
      new RegExp(
        `<img\\b[^>]*\\bsrc="(https://${EDEKA_OFFER_IMAGE_HOST.replace(/\./g, '\\.')}/[^"]+)"[^>]*>`,
        'gi',
      ),
    ),
  ];
  if (imgs.length === 0) {
    return undefined;
  }
  // Das Produktbild wird gro\u00df (aspect-square / max-w-92) gerendert; die kleinen
  // Marken-/Siegel-Logos tragen max-w-20 / height="80". Bevorzuge das gro\u00dfe
  // Bild, sonst das zuletzt gerenderte (Produkt steht nach den Logos).
  const product =
    imgs.find((m) => /aspect-square|max-w-92/i.test(m[0])) ?? imgs[imgs.length - 1];
  return resolveUrl(product[1], baseUrl);
}

interface EdekaCardParse {
  candidate: RawOfferCandidate | null;
  reject?: EdekaRejectReason;
  rejectName?: string;
  hadImage: boolean;
  validityStart?: string;
}

/** Eine einzelne <dialog>-Angebotskarte strukturiert lesen. Trennt
 *  Angebotspreis (Festpreis/Rabattierter Preis), App-/Bonuspreis, Normalpreis
 *  (nur PAYBACK-Punkte \u2192 KEIN Angebotspreis) und Grundpreis. */
function parseEdekaOfferCard(block: string, store: OfficialStoreConfig): EdekaCardParse {
  const nameMatch = block.match(
    /sr-only[^>]*>\s*Angebot:\s*<\/span>([\s\S]*?)<\/(?:a|h2|h3)>/i,
  );
  const name = stripHtml(nameMatch?.[1] ?? '');
  const { start: validityStart, end: validityEnd } = parseEdekaValidity(block);

  if (!name) {
    return { candidate: null, reject: 'kein_name', hadImage: false, validityStart };
  }

  const labels = edekaSrOnlyLabels(block);
  const festpreis = edekaPriceFromLabels(labels, /Festpreis von\s*([\d.,]+)\s*(?:\u20ac|EUR)/i);
  const appPreis = edekaPriceFromLabels(labels, /App-?Preis von\s*([\d.,]+)\s*(?:\u20ac|EUR)/i);
  const rabatt = edekaPriceFromLabels(
    labels,
    /Rabattierter Preis von\s*([\d.,]+)\s*(?:\u20ac|EUR)/i,
  );

  // Angebotspreis = der f\u00fcr ALLE geltende reduzierte Preis (Festpreis bzw.
  // Rabattierter Preis). Der App-Preis ist ein an die EDEKA-App + Lieblingsmarkt
  // gebundener BONUS-Preis \u2014 er wird NIE als regul\u00e4rer Angebotspreis importiert,
  // au\u00dfer er ist der einzige reduzierte Preis (dann mit App-Tag).
  const offerPrice = festpreis ?? rabatt ?? appPreis;
  const appOnly = appPreis !== undefined && festpreis === undefined && rabatt === undefined;
  const blockText = stripHtml(block);

  if (offerPrice === undefined) {
    // Kein reduzierter Preis. PAYBACK-Punkte-"Angebote" zeigen nur einen
    // Normalpreis (+ Extra\u00b0Punkte) \u2014 ein Normalpreis darf NIEMALS als
    // Angebotspreis importiert werden (sonst Schein-Rabatt).
    const reason: EdekaRejectReason = /Normalpreis|PAYBACK|Extra.?Punkte/i.test(blockText)
      ? 'kein_angebotspreis'
      : 'kein_preis';
    return { candidate: null, reject: reason, rejectName: name, hadImage: false, validityStart };
  }

  // Grundpreis passend zum importierten Preis w\u00e4hlen: bei App-only der "mit App",
  // sonst der regul\u00e4re (plain / "ohne App"). Niemals den Grundpreis als
  // Verkaufspreis verwenden.
  // Wert mit deutschem Dezimalkomma zulassen ([\d.,]+ statt [^,;]) — sonst wird
  // "1kg = € 5,16" am Komma auf "5" abgeschnitten.
  const grundValue = /([\s\S]*?=\s*(?:€|EUR)?\s*[\d.,]+)/;
  const grundMitApp = blockText.match(
    new RegExp(`Grundpreis mit App:\\s*${grundValue.source}`, 'i'),
  )?.[1];
  const grundOhneApp = blockText.match(
    new RegExp(`Grundpreis ohne App:\\s*${grundValue.source}`, 'i'),
  )?.[1];
  const grundPlain = blockText.match(
    new RegExp(`Grundpreis:\\s*${grundValue.source}`, 'i'),
  )?.[1];
  const grundText = appOnly
    ? grundMitApp ?? grundPlain ?? grundOhneApp
    : grundPlain ?? grundOhneApp ?? grundMitApp;
  const baseParts = parseBasePriceText(grundText);

  // Einheit/Beschreibung: erster nicht-leerer <p>-Absatz der Karte.
  const unit = (() => {
    for (const m of block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      const text = stripHtml(m[1]);
      if (text) {
        return text;
      }
    }
    return undefined;
  })();

  const imageUrl = edekaCardImage(block, store.url);
  const tags = ['edeka-angebot', 'national'];
  if (appPreis !== undefined) {
    tags.push('edeka-app-preis');
  }

  const candidate = buildCandidate({
    storeChain: store.storeChain,
    name,
    price: offerPrice,
    basePrice: baseParts.basePrice,
    baseUnit: baseParts.baseUnit,
    unit,
    imageUrl,
    sourceUrl: store.url,
    category: 'EDEKA Angebote',
    validityStart,
    validityEnd,
    tags,
    sourceScope: 'national',
  });

  return { candidate, hadImage: Boolean(imageUrl), validityStart };
}

/** Sieht die geladene Seite nach der EDEKA-Angebots-Struktur aus? Unterscheidet
 *  "Layout ge\u00e4ndert / Parser-Verdacht" von einer echten Block-/Fehlerseite. */
function edekaPageLooksLikeOffers(html: string): boolean {
  return /dialog-angebot-|national-offers|edeka_neu|id=["']__NEXT_DATA__["']/i.test(html);
}

/** Erkennt eine Anti-Bot-/Captcha-/Block-Seite, die mit HTTP 200 ausgeliefert
 *  werden kann (kein Bypass \u2014 nur ehrliche Klassifikation). */
function edekaLooksBlocked(html: string): boolean {
  return (
    /captcha|challenge|access denied|zugriff verweigert|cf-browser-verification|are you a (?:robot|human)|bitte best[\u00e4a]tigen sie/i.test(
      html,
    ) && !/dialog-angebot-/i.test(html)
  );
}

/**
 * Liest alle EDEKA-Angebotskarten + baut die maschinenlesbare Z\u00e4hlkette.
 * Pure (kein IO): `html` kommt vom Fetch, `httpStatus` optional zur Diagnose.
 */
export function parseEdekaOffers(
  html: string,
  store: OfficialStoreConfig,
  options: { httpStatus?: number; now?: Date } = {},
): { offers: RawOfferCandidate[]; diagnostics: EdekaImportDiagnostics } {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const blocks = [
    ...html.matchAll(/<dialog id="dialog-angebot-[0-9a-f-]+"[\s\S]*?<\/dialog>/gi),
  ].map((match) => match[0]);

  const rejectedByReason = emptyEdekaRejections();
  const rejectedExamples: string[] = [];
  const parsedCandidates: RawOfferCandidate[] = [];
  let candidates = 0;
  let brokenImageCount = 0;
  let validityStartSeen: string | undefined;

  for (const block of blocks) {
    const parse = parseEdekaOfferCard(block, store);
    if (parse.validityStart && (!validityStartSeen || parse.validityStart < validityStartSeen)) {
      validityStartSeen = parse.validityStart;
    }
    if (parse.reject) {
      rejectedByReason[parse.reject] += 1;
      const label = parse.rejectName ? `${parse.rejectName} (${parse.reject})` : parse.reject;
      if (rejectedExamples.length < 8 && !rejectedExamples.includes(label)) {
        rejectedExamples.push(label);
      }
      continue;
    }
    candidates += 1;
    if (!parse.hadImage) {
      brokenImageCount += 1;
    }
    if (parse.candidate) {
      parsedCandidates.push(parse.candidate);
    }
  }

  // Inhaltliche Dublettenzusammenf\u00fchrung (Produkt + Markt via stabiler ID).
  const byId = new Map<string, RawOfferCandidate>();
  for (const offer of parsedCandidates) {
    if (offer.id) {
      byId.set(offer.id, offer);
    }
  }
  const offers = [...byId.values()];

  const blocked = blocks.length === 0 && edekaLooksBlocked(html);
  const diagnostics: EdekaImportDiagnostics = {
    generatedAt,
    sourceUrl: store.url,
    blocked,
    blockReason: blocked ? 'Block-/Captcha-/Anti-Bot-Seite (HTTP 200)' : undefined,
    httpStatus: options.httpStatus,
    pageLooksLikeOffers: edekaPageLooksLikeOffers(html),
    marketScope: offers.length > 0 ? 'national' : 'none',
    offerBlocks: blocks.length,
    candidates,
    withOfferPrice: parsedCandidates.length,
    importedDistinct: offers.length,
    duplicatesMerged: parsedCandidates.length - offers.length,
    rejectedByReason,
    rejectedExamples,
    brokenImageCount,
    lastSuccessfulAt: offers.length > 0 ? generatedAt : undefined,
    validityStartSeen,
  };

  return { offers, diagnostics };
}

// Letzte EDEKA-Import-Diagnose dieses Prozesses (analog Kaufland): wird beim
// Scrape gesetzt und vom Scan-Report gelesen, ohne erneut zu fetchen.
let lastEdekaDiagnostics: EdekaImportDiagnostics | null = null;

export function getLastEdekaDiagnostics(): EdekaImportDiagnostics | null {
  return lastEdekaDiagnostics;
}

/** Block-/Fehlerdiagnose setzen, wenn der EDEKA-Fetch gar nicht durchkam
 *  (403/Captcha/Timeout) \u2014 damit der Report EDEKA ehrlich als blocked zeigt,
 *  statt den Store verschwinden zu lassen. */
function recordEdekaFetchFailure(store: OfficialStoreConfig, error: unknown): void {
  const message = error instanceof Error ? error.message : 'unbekannter Fehler';
  const statusMatch = message.match(/\b(\d{3})\b/);
  lastEdekaDiagnostics = {
    generatedAt: new Date().toISOString(),
    sourceUrl: store.url,
    blocked: true,
    blockReason: message,
    httpStatus: statusMatch ? Number(statusMatch[1]) : undefined,
    pageLooksLikeOffers: false,
    marketScope: 'none',
    offerBlocks: 0,
    candidates: 0,
    withOfferPrice: 0,
    importedDistinct: 0,
    duplicatesMerged: 0,
    rejectedByReason: emptyEdekaRejections(),
    rejectedExamples: [],
    brokenImageCount: 0,
  };
}

function parseNettoPrice(block: string): number | undefined {
  const srOnlyPrice = block.match(/Aktueller Preis:\s*([\s\S]*?)(?:\u20ac|&euro;)/i)?.[1];
  if (srOnlyPrice) {
    return parseDecimal(stripHtml(srOnlyPrice));
  }

  const priceHtml =
    block.match(
      /<(?:ins|div)[^>]*class=["'][^"']*tc-product-price[^"']*["'][^>]*>([\s\S]*?)<\/(?:ins|div)>/i,
    )?.[1] ??
    block.match(
      /<span[^>]+aria-hidden=["']true["'][^>]*>\s*([\d.,\s&;a-zA-Z-]+?)\s*<\/span>/i,
    )?.[1];

  if (!priceHtml) {
    return undefined;
  }

  return parseDecimal(stripHtml(priceHtml).replace(/\s+/g, ''));
}

/**
 * Parse the validity range out of Netto's "ValidityPeriod" text
 * ("gültig von Montag, 08.06.26 - Samstag, 13.06.26"). Two-digit years are
 * 2000-based. Returns ISO start/end (end = end of day) — no calendar-week
 * assumptions, the dates come verbatim from the tile.
 */
function parseNettoValidityPeriod(
  value: string | undefined,
): { start?: string; end?: string } {
  const text = stripHtml(value ?? '');
  const match = text.match(
    /(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*(?:-|–|bis)\s*(?:[\p{L}]+,?\s*)?(\d{1,2})\.(\d{1,2})\.(\d{2,4})/u,
  );
  if (!match) {
    return {};
  }
  const year = (raw: string): number => {
    const num = Number(raw);
    return raw.length === 2 ? 2000 + num : num;
  };
  const pad = (raw: string): string => raw.padStart(2, '0');
  return {
    start: `${year(match[3])}-${pad(match[2])}-${pad(match[1])}T00:00:00.000Z`,
    end: `${year(match[6])}-${pad(match[5])}-${pad(match[4])}T23:59:59.999Z`,
  };
}

/**
 * Extract the structured offer data Netto embeds in each store tile's
 * "ViewMMPWishlist-AddStoreArticle" link (SKU, Name, Price, ValidTo,
 * ValidityPeriod, Image, BundleText, Text). This is part of the served HTML —
 * no extra request — and is the most reliable source for price + REAL validity
 * (the old parser had no validity at all and defaulted to "now + 7 days").
 */
function parseNettoStoreArticleParams(block: string): Record<string, string> | null {
  const href = block.match(
    /href=["']([^"']*ViewMMPWishlist-AddStoreArticle\?[^"']+)["']/i,
  )?.[1];
  if (!href) {
    return null;
  }
  try {
    const url = new URL(decodeHtml(href), 'https://www.netto-online.de/');
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      const trimmed = value.trim();
      if (trimmed) params[key] = trimmed;
    }
    return params;
  } catch {
    return null;
  }
}

function parseNettoProductTiles(
  html: string,
  store: OfficialStoreConfig,
): RawOfferCandidate[] {
  const offers: RawOfferCandidate[] = [];
  const markers = [
    ...html.matchAll(
      /<(?:li|div)\b[^>]*class=["'][^"']*js-store-product-tile[^"']*["'][^>]*>/gi,
    ),
  ];

  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const next = markers[index + 1];
    const block = html.slice(marker.index, next?.index);
    const article = parseNettoStoreArticleParams(block);
    const nameMatch = block.match(
      /<h[34]\b[^>]*class=["'][^"']*tc-product-name[^"']*["'][^>]*>([\s\S]*?)<\/h[34]>/i,
    );
    const name = stripHtml(nameMatch?.[1] ?? '') || stripHtml(article?.Name ?? '');
    const sourceUrl =
      resolveUrl(block.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1], store.url) ??
      store.url;
    const imageUrl =
      resolveUrl(
        getAttribute(block, 'data-src') ?? getAttribute(block, 'src'),
        store.url,
      ) ?? resolveUrl(article?.Image, store.url);
    const unit =
      stripHtml(
        block.match(/product-property__bundle-text["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '',
      ) || stripHtml(article?.BundleText ?? '');
    const baseParts = parseBasePriceText(
      block.match(/product-property__base-price["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ??
        article?.BasePrice,
    );
    const originalPrice =
      parseDecimal(
        stripHtml(
          block.match(/product__(?:old-price|uvp)[^>]*>([\s\S]*?)<\/(?:del|span|s)>/i)?.[1] ?? '',
        ),
      ) ?? undefined;
    // Real validity from the tile data: ValidityPeriod carries start AND end
    // ("gültig von Montag, 08.06.26 - Samstag, 13.06.26"), ValidTo
    // ("2026-06-13 20:00:00") backs up the end date.
    const validity = parseNettoValidityPeriod(article?.ValidityPeriod);
    const validityEnd =
      validity.end ?? parseDateTime(article?.ValidTo?.replace(' ', 'T'));

    const candidate = buildCandidate({
      storeChain: store.storeChain,
      name,
      price: parseNettoPrice(block) ?? parseDecimal(article?.Price),
      originalPrice,
      unit,
      basePrice: baseParts.basePrice,
      baseUnit: baseParts.baseUnit,
      imageUrl,
      sourceUrl,
      category: 'Filialangebote',
      validityStart: validity.start,
      validityEnd,
      tags: ['filiale'],
    });

    if (candidate) {
      // Validity-aware id (Kaufland/Lidl precedent): the same product offered
      // in two windows ("ab Montag" next to the running week) stays distinct.
      if (validity.start || validityEnd) {
        candidate.id = stableOfficialId(
          store.storeChain,
          `${candidate.name}|${validity.start ?? ''}|${validityEnd ?? ''}`,
          store.url,
        );
      }
      offers.push(candidate);
    }
  }

  return offers;
}

function extractBalancedObject(source: string, openBraceIndex: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex, index + 1);
      }
    }
  }

  return undefined;
}

function extractKauflandSsrData(html: string): unknown[] {
  const values: unknown[] = [];
  const marker = 'window.SSR';
  let cursor = html.indexOf(marker);

  while (cursor >= 0) {
    const assignmentIndex = html.indexOf('=', cursor);
    const openBraceIndex = html.indexOf('{', assignmentIndex);
    if (assignmentIndex < 0 || openBraceIndex < 0) {
      break;
    }

    const objectText = extractBalancedObject(html, openBraceIndex);
    if (objectText) {
      try {
        values.push(JSON.parse(objectText) as unknown);
      } catch {
        // Ignore unrelated SSR blocks.
      }
      cursor = openBraceIndex + objectText.length;
    } else {
      cursor = openBraceIndex + 1;
    }
    cursor = html.indexOf(marker, cursor);
  }

  return values;
}

// Eindeutige Non-Food-Kategorienamen aus dem Kaufland-SSR (Bekleidung, Drogerie,
// Technik, K\u00fcchen-Highlights, Pflanzen/Blumen \u2026). Bewusst auf Kategorienamen
// angewandt (nicht auf Produktnamen), damit "Hausmacher Wurst" o. \u00c4. NICHT
// f\u00e4lschlich rausfliegt. Pflanzen/Blumen gelten nur dann als Lebensmittel, wenn
// die Kategorie klar Obst/Gem\u00fcse ist (separate Food-Liste unten gewinnt).
const KAUFLAND_NON_FOOD_CATEGORY_KEYWORDS = [
  'drogerie',
  'kosmetik',
  'koerperpflege',
  'parfuem',
  'bekleidung',
  'mode',
  'schuhe',
  'textil',
  'waesche',
  'haushalt',
  'haus-',
  'heim',
  'kueche', // "K\u00fcchen-Highlights", "K\u00fcchenwelt"
  'geschirr',
  'technik',
  'elektro',
  'multimedia',
  'medien',
  'foto',
  'buero',
  'schreibwaren',
  'spielwaren',
  'spielzeug',
  'spiel',
  'freizeit',
  'garten',
  'pflanze',
  'blume',
  'baumarkt',
  'werkzeug',
  'auto',
  'kfz',
  'tierbedarf',
  'tiernahrung',
  'heimtier',
  'nike',
  'sport',
  'deko',
  'moebel',
  'wohnen',
];

// Kategorienamen, die trotz m\u00f6glicher Non-Food-Teiltreffer KLAR Lebensmittel
// sind (Schutz gegen Substring-Fehlalarme, z. B. zuk\u00fcnftige Kombinamen).
const KAUFLAND_FOOD_CATEGORY_KEYWORDS = [
  'obst',
  'gemuese',
  'fleisch',
  'wurst',
  'fisch',
  'molkerei',
  'milch',
  'kaese',
  'backwaren',
  'brot',
  'getraenke',
  'tiefkuehl',
  'konserv',
  'suesswaren',
  'snack',
  'feinkost',
];

export function isKauflandNonFoodCategory(categoryName: string | undefined): boolean {
  const normalized = normalizeText(categoryName ?? '');
  if (!normalized) {
    return false;
  }
  if (KAUFLAND_FOOD_CATEGORY_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return false;
  }
  return KAUFLAND_NON_FOOD_CATEGORY_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/** Kategorie-Name ist KLAR Lebensmittel ("Molkereiprodukte", "Obst & Gemüse").
 *  Gemischte Promo-/Aktionskategorien ("Badespaß für die Kleinen", "Angebote
 *  zum Wochenstart") sind weder Food noch Non-Food — beide Checks sagen false.
 *  Eine Kategorie, die NEBEN einem Food- AUCH ein Non-Food-Stichwort trägt, ist
 *  ebenfalls gemischt ("Obst, Gemüse, Pflanzen" = Lebensmittel + Zierpflanzen):
 *  sie wird NICHT als KLAR Lebensmittel bestätigt (foodCategoryConfirmed=false),
 *  damit ein korrekt gefiltertes, unsicheres Zierpflanzen-Angebot daraus nicht
 *  als „falsch gefiltertes Food" (matchedFiltered) zählt — sondern transparent
 *  als matchedFilteredUnconfirmed. Echtes Food aus der Mischabteilung mit hartem
 *  Food-Beleg bleibt davon unberührt (Rescue-Verdict 'rescue' → Verdacht, kat-
 *  unabhängig). Sie bleibt aber auch NICHT Non-Food (isKauflandNonFoodCategory
 *  gibt dem Food-Stichwort Vorrang) — echtes Obst/Gemüse wird nie weggefiltert.
 *  Diese Dreiteilung trägt die Vollständigkeits-Partition (s. unten). */
export function isKauflandFoodCategory(categoryName: string | undefined): boolean {
  const normalized = normalizeText(categoryName ?? '');
  if (!normalized) {
    return false;
  }
  if (!KAUFLAND_FOOD_CATEGORY_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return false;
  }
  // Mischkategorie (Food + Non-Food im selben Namen) ist nicht KLAR Lebensmittel.
  return !KAUFLAND_NON_FOOD_CATEGORY_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/** Build the Kaufland product name from title + subtitle (shared by the parser
 *  and the completeness analyzer so both see exactly the same name). The SSR
 *  JSON carries the U+2028 line separator BOTH as a literal character and as
 *  the raw HTML entity `&#x2028;` inside the JSON string \u2014 decode the entity
 *  first, otherwise the analyzer side sees "K-WERTSCH\u00c4TZE&#x2028;H\u00fcftsteak"
 *  while the import side (which strips HTML) sees "K-WERTSCH\u00c4TZE H\u00fcftsteak",
 *  and ~270 real imports are wrongly reported as missing. */
/** Führender Kaufland-Card-Promo-Anker ("*Mit Kaufland Card <Produkt>"): reiner
 *  Preis-Kontext (Card-Aktionspreis), NICHT Teil des Produktnamens. Im Namen
 *  verschmutzt er die KI-Klassifikation der Phase 2 (belegt: "…Card
 *  Bacon-Scheiben" → "Süßwaren & Snacks"), den produktstabilen Key
 *  (Cross-Store-Reuse/Cheffity-Matching) und die App-Anzeige. Kein Produkt-/
 *  Marken-Hardcode — nur das generische Promo-Format der Kette. */
const KAUFLAND_CARD_PREFIX = /^[*\s]*mit\s+kaufland\s+card\s*/i;

/**
 * Trennt den Kaufland-Card-Promo-Anker vom Produktnamen. `kauflandCard: true`
 * hält die Bedingung maschinenlesbar fest (der Preis gilt mit Card) — die
 * Information geht also nicht verloren, sie wandert nur aus dem Namen in ein
 * Tag. Würde das Strippen den Namen leeren (reiner Card-Teaser), bleibt das
 * Original erhalten. Pure + testbar.
 */
export function splitKauflandCardPrefix(name: string): { name: string; kauflandCard: boolean } {
  const raw = String(name ?? '');
  const match = raw.match(KAUFLAND_CARD_PREFIX);
  if (!match || match[0].trim().length === 0) {
    return { name: raw, kauflandCard: false };
  }
  const stripped = raw.slice(match[0].length).trim();
  return { name: stripped.length >= 2 ? stripped : raw, kauflandCard: true };
}

function kauflandOfferName(value: Record<string, unknown>): string {
  const title = decodeHtml(textValue(value.detailTitle) ?? textValue(value.title) ?? '')
    .replace(/\u2028/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const subtitle = decodeHtml(textValue(value.subtitle) ?? '')
    .replace(/\u2028/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || undefined;
  return subtitle && !normalizeText(title).includes(normalizeText(subtitle))
    ? `${title} ${subtitle}`.trim()
    : title;
}

function parseKauflandOffer(
  value: Record<string, unknown>,
  store: OfficialStoreConfig,
  categoryName?: string,
): RawOfferCandidate | null {
  // Card-Promo-Anker aus dem Namen trennen: sauberer Produktname für KI/Key/
  // Anzeige, die Card-Bedingung bleibt als Tag 'kaufland-card' erhalten.
  const { name, kauflandCard } = splitKauflandCardPrefix(kauflandOfferName(value));
  const baseParts = parseBasePriceText(textValue(value.basePrice));
  const dateFrom = textValue(value.dateFrom);
  const dateTo = textValue(value.dateTo);

  const candidate = buildCandidate({
    storeChain: store.storeChain,
    name,
    price: parseDecimal(numberText(value.price)) ?? parseDecimal(textValue(value.formattedPrice)),
    originalPrice: parseDecimal(textValue(value.formattedOldPrice)),
    unit: textValue(value.unit),
    basePrice: baseParts.basePrice,
    baseUnit: baseParts.baseUnit,
    imageUrl: resolveUrl(textValue(value.listImage), store.url),
    sourceUrl: store.url,
    category: categoryName ?? 'Kaufland Angebote',
    validityStart: dateOnlyToIso(dateFrom),
    validityEnd: dateOnlyToIso(dateTo, true),
    tags: [
      ...(kauflandCard ? ['kaufland-card'] : []),
      ...(Number(value.discount ?? 0) > 0 || textValue(value.formattedOldPrice)
        ? ['reduziert']
        : []),
    ],
  });

  if (!candidate) {
    return null;
  }

  // Validity-aware id: the same product offered in the current AND the next week
  // must stay two distinct offers. The old name+url id collapsed them (last
  // write won \u2192 the future variant), silently dropping current-week offers.
  candidate.id = stableOfficialId(
    store.storeChain,
    `${candidate.name}|${dateFrom ?? ''}|${dateTo ?? ''}`,
    store.url,
  );

  // Non-food category \u2192 carry an unambiguous "nonfood" tag so the strict food
  // filter routes it to `filtered` in BOTH scan versions, even after the raw
  // category has been collapsed to the simple taxonomy.
  if (isKauflandNonFoodCategory(categoryName)) {
    candidate.tags = [...new Set([...(candidate.tags ?? []), 'nonfood'])];
  }

  return candidate;
}

function parseKauflandOffersFromHtml(
  html: string,
  store: OfficialStoreConfig,
): RawOfferCandidate[] {
  const ssrBlocks = extractKauflandSsrData(html);
  const offers: RawOfferCandidate[] = [];

  for (const block of ssrBlocks) {
    for (const category of collectRecordsWithKey(block, 'offers')) {
      const categoryOffers = Array.isArray(category.offers) ? category.offers : [];
      for (const offer of categoryOffers.filter(isRecord)) {
        const candidate = parseKauflandOffer(
          offer,
          store,
          textValue(category.displayName) ?? textValue(category.name),
        );
        if (candidate) {
          offers.push(candidate);
        }
      }
    }
  }

  const byId = new Map<string, RawOfferCandidate>();
  for (const offer of offers) {
    if (offer.id) {
      byId.set(offer.id, offer);
    }
  }
  return [...byId.values()];
}

export interface KauflandSsrAnalysis {
  /** Every offer object in the SSR, across all cycles (current + future). */
  officialTotalCount: number;
  /** Offer objects whose validity window is active today. */
  officialCurrentCount: number;
  /** Current-week offer objects in a food category (the honest "should be live"). */
  officialFoodishCount: number;
  /** Offer objects whose validity starts in the future (next week / upcoming). */
  upcomingCount: number;
  /** Current-week offer objects in an obvious non-food category. */
  nonFoodCount: number;
  /** Distinct current-week food offers (by normalized name) for missing-checks.
   *  `foodCategoryConfirmed` = die offizielle Kategorie ist KLAR Lebensmittel
   *  (isKauflandFoodCategory); false = gemischte Promo-/Aktionskategorie, die
   *  nur mangels Non-Food-Keyword als "Food" gezählt wurde. */
  currentFoodOffers: Array<{
    name: string;
    category: string;
    price: number | undefined;
    foodCategoryConfirmed: boolean;
  }>;
}

/**
 * Pure completeness analysis of a Kaufland SSR page. Counts the official offer
 * objects, splits current vs upcoming via dateFrom/dateTo and food vs non-food
 * via the category name \u2014 the basis for the "Kaufland darf nicht nur 337 statt
 * ~593 food-Angebote liefern" check. No network, no dedup side effects.
 */
export function analyzeKauflandSsr(
  html: string,
  now: Date = new Date(),
): KauflandSsrAnalysis {
  const ssrBlocks = extractKauflandSsrData(html);
  let officialTotalCount = 0;
  let officialCurrentCount = 0;
  let officialFoodishCount = 0;
  let upcomingCount = 0;
  let nonFoodCount = 0;
  const currentFoodByName = new Map<
    string,
    { name: string; category: string; price: number | undefined; foodCategoryConfirmed: boolean }
  >();

  for (const block of ssrBlocks) {
    for (const category of collectRecordsWithKey(block, 'offers')) {
      const categoryName = textValue(category.displayName) ?? textValue(category.name) ?? '';
      const nonFood = isKauflandNonFoodCategory(categoryName);
      const foodConfirmed = isKauflandFoodCategory(categoryName);
      const categoryOffers = Array.isArray(category.offers) ? category.offers : [];
      for (const offer of categoryOffers.filter(isRecord)) {
        officialTotalCount += 1;
        const bucket = classifyOfferBucket(
          {
            validityStart: dateOnlyToIso(textValue(offer.dateFrom)),
            validityEnd: dateOnlyToIso(textValue(offer.dateTo), true),
          },
          now,
        );
        if (bucket === 'upcoming') {
          upcomingCount += 1;
          continue;
        }
        if (bucket !== 'current') {
          continue; // expired offer objects don't count toward the current week
        }
        officialCurrentCount += 1;
        if (nonFood) {
          nonFoodCount += 1;
          continue;
        }
        officialFoodishCount += 1;
        // Card-Anker auch in der offiziellen Namensliste strippen, damit die
        // Completeness-Beispiele dieselben sauberen Namen wie der Import tragen.
        const name = splitKauflandCardPrefix(kauflandOfferName(offer)).name;
        const key = normalizeText(name);
        if (!key) {
          continue;
        }
        const existing = currentFoodByName.get(key);
        if (!existing) {
          currentFoodByName.set(key, {
            name,
            category: categoryName,
            price: parseDecimal(numberText(offer.price)) ?? parseDecimal(textValue(offer.formattedPrice)),
            foodCategoryConfirmed: foodConfirmed,
          });
        } else if (foodConfirmed && !existing.foodCategoryConfirmed) {
          // Dasselbe Produkt in Promo- UND Food-Kategorie: Food-Beleg gewinnt
          // (OR über alle Kategorieblöcke).
          existing.foodCategoryConfirmed = true;
        }
      }
    }
  }

  return {
    officialTotalCount,
    officialCurrentCount,
    officialFoodishCount,
    upcomingCount,
    nonFoodCount,
    currentFoodOffers: [...currentFoodByName.values()],
  };
}

// ─── Kaufland-Vollständigkeit (fachlich definierte Metriken) ─────────────────
//
// Begriffsdefinitionen (gelten überall — Report, Health, Tests):
//   officialFoodishCount        SSR-Angebots-OBJEKTE der AKTUELLEN Woche in
//                               Food-Kategorien, INKLUSIVE Dubletten desselben
//                               Produkts über mehrere Kategorieblöcke.
//                               Transparenzwert — KEINE Vergleichsbasis.
//   officialDistinctFoodCount   Distinct normalisierte Namen daraus — die
//                               Vergleichsbasis für matched/missing.
//   matchedCount                Offizielle Namen, die im SICHTBAREN Snapshot
//                               (current + next Buckets) gefunden wurden.
//   matchedFilteredCount        Offizielle Food-Namen, die zwar importiert,
//                               aber in den Filtered-Bucket einsortiert wurden
//                               (Kategorisierungs-Verlust, kein Parser-Verlust).
//   matchedFilteredUnconfirmedCount
//                               Offizielle Namen aus GEMISCHTEN Promo-/Aktions-
//                               kategorien (nicht food-bestätigt), deren
//                               Snapshot-Angebot ohne Beleg in beide Richtungen
//                               gefiltert ist (Rescue-Verdict 'review') —
//                               erklärt/transparent, kein Food-Verlust-Indiz.
//   missingEstimate             officialDistinctFoodCount − matched −
//                               matchedFiltered − matchedFilteredNonFood −
//                               matchedFilteredUnconfirmed: nirgends gefunden
//                               (echter Parser-/Importverlust).
//   unmatchedImportedCount      Importierte AKTUELLE Kaufland-Namen ohne
//                               offizielles Gegenstück (Namensvarianten,
//                               Diagnose — zählt nicht als Fehler).
// Die offizielle NÄCHSTE Woche ist bewusst NICHT Teil des Vergleichs
// (comparisonScope sagt das im Report).
export interface KauflandCompleteness {
  officialFoodishCount: number;
  officialDistinctFoodCount: number;
  matchedCount: number;
  /** Im Filtered-Bucket OHNE regelbestätigtes Non-Food-Signal — VERDACHT auf
   *  falsch gefiltertes Food (löst die Health-Warnung aus). */
  matchedFilteredCount: number;
  /** Im Filtered-Bucket MIT regelbestätigtem Non-Food-Signal (Tag/Keyword):
   *  die offizielle Kategorie war gemischt (Markenwochen/Euro-Sparwoche), das
   *  Produkt ist wirklich Non-Food — erklärt die Lücke, kein Fehler. */
  matchedFilteredNonFoodCount: number;
  /** Im Filtered-Bucket OHNE Beleg in beide Richtungen (Rescue-Verdict
   *  'review'), aus einer GEMISCHTEN offiziellen Promo-/Aktionskategorie
   *  (der Tankini/Holzkohle-Fall): die offizielle Kategorie liefert keinen
   *  Food-Beleg, das Angebot bleibt reviewNeeded im Filtered-Bucket —
   *  transparent ausgewiesen, aber kein Food-Verlust-Verdacht. Derselbe
   *  Review-Fall aus einer ECHTEN Food-Kategorie zählt weiter als
   *  matchedFilteredCount (keine Schönung). */
  matchedFilteredUnconfirmedCount: number;
  missingEstimate: number;
  missingExamples: string[];
  unmatchedImportedCount: number;
  /** @deprecated Alias für matchedCount (alte Reports/Aufrufer). */
  importedCurrentCount: number;
  /** Klartext, was verglichen wird — macht den Report ohne Code lesbar. */
  comparisonScope: string;
}

export const KAUFLAND_COMPARISON_SCOPE =
  'Vergleich: distinct Namen der offiziellen AKTUELLEN Food-Woche gegen den Snapshot (current+next sichtbar, filtered getrennt); die nächste offizielle Woche ist nicht Teil des Vergleichs.';

/**
 * Normalisiert einen Kaufland-Angebotsnamen für das Vollständigkeits-Matching:
 * HTML-Entities (&#x2028; …) und U+2028 → Leerzeichen, führende Sternchen und
 * der "Mit Kaufland Card"-Promo-Prefix werden entfernt, dann normalizeText.
 * Wochenunabhängig und ohne Produktbezug — nur Format-/Promo-Rauschen.
 */
export function normalizeKauflandMatchName(name: string): string {
  const decoded = decodeHtml(String(name ?? ''))
    .replace(/\u2028/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let normalized = normalizeText(decoded);
  normalized = normalized.replace(/^[*\s]+/, '').trim();
  if (normalized.startsWith('mit kaufland card')) {
    normalized = normalized.slice('mit kaufland card'.length).trim();
  }
  return normalized;
}

export interface KauflandImportedNames {
  /** Namen im current-Bucket des Snapshots (Kaufland). */
  currentNames: readonly string[];
  /** Namen im nextWeek-Bucket (zählen als sichtbar/matched). */
  nextWeekNames?: readonly string[];
  /** Filtered-Bucket-Namen OHNE regelbestätigtes Non-Food-Signal —
   *  Verdachtsfälle für falsch gefiltertes Food. */
  filteredNames?: readonly string[];
  /** Filtered-Bucket-Namen MIT regelbestätigtem Non-Food-Signal (nonfood-Tag,
   *  starke Keywords) — wirklich Non-Food in gemischten offiziellen Kategorien. */
  filteredNonFoodNames?: readonly string[];
  /** Filtered-Bucket-Namen OHNE Beleg in beide Richtungen (Rescue-Verdict
   *  'review', s. partitionFilteredOffersForCompleteness): nur bei offizieller
   *  Food-Kategorie ein Verdacht, sonst erklärter Promo-Mischkategorie-Fall. */
  filteredUnconfirmedNames?: readonly string[];
}

/** Match: exakt ODER Containment (der kürzere offizielle Kurzname — z. B. ein
 *  Card-Teaser-Objekt "Aperitivo" — steckt im längeren importierten Namen). */
function kauflandNameMatches(official: string, imported: readonly string[]): boolean {
  for (const name of imported) {
    if (name === official) return true;
    if (official.length >= 4 && name.includes(official)) return true;
    if (name.length >= 4 && official.includes(name)) return true;
  }
  return false;
}

/**
 * Vollständigkeitsvergleich nach den oben definierten Metriken. Pure; alle
 * Zahlen beziehen sich auf DIESELBE Basis (distinct normalisierte Namen), so
 * dass officialDistinctFoodCount = matched + matchedFiltered +
 * matchedFilteredNonFood + matchedFilteredUnconfirmed + missing gilt.
 */
export function buildKauflandCompleteness(
  analysis: KauflandSsrAnalysis,
  imported: KauflandImportedNames,
  maxExamples = 12,
): KauflandCompleteness {
  const visible = [
    ...new Set(
      [...imported.currentNames, ...(imported.nextWeekNames ?? [])]
        .map(normalizeKauflandMatchName)
        .filter(Boolean),
    ),
  ];
  const filtered = [
    ...new Set((imported.filteredNames ?? []).map(normalizeKauflandMatchName).filter(Boolean)),
  ];
  const filteredNonFood = [
    ...new Set(
      (imported.filteredNonFoodNames ?? []).map(normalizeKauflandMatchName).filter(Boolean),
    ),
  ];
  const filteredUnconfirmed = [
    ...new Set(
      (imported.filteredUnconfirmedNames ?? []).map(normalizeKauflandMatchName).filter(Boolean),
    ),
  ];

  let matchedCount = 0;
  let matchedFilteredCount = 0;
  let matchedFilteredNonFoodCount = 0;
  let matchedFilteredUnconfirmedCount = 0;
  const missing: string[] = [];
  const officialNormalized: string[] = [];
  for (const offer of analysis.currentFoodOffers) {
    const normalized = normalizeKauflandMatchName(offer.name);
    if (!normalized) continue;
    officialNormalized.push(normalized);
    if (kauflandNameMatches(normalized, visible)) {
      matchedCount += 1;
    } else if (kauflandNameMatches(normalized, filtered)) {
      matchedFilteredCount += 1;
    } else if (kauflandNameMatches(normalized, filteredNonFood)) {
      matchedFilteredNonFoodCount += 1;
    } else if (kauflandNameMatches(normalized, filteredUnconfirmed)) {
      // Ohne Beleg in beide Richtungen entscheidet die offizielle Kategorie:
      // echte Food-Kategorie ⇒ Verdacht bleibt (keine Schönung); gemischte
      // Promo-Kategorie ⇒ erklärter Review-Fall (Tankini/Holzkohle-Fall).
      if (offer.foodCategoryConfirmed) {
        matchedFilteredCount += 1;
      } else {
        matchedFilteredUnconfirmedCount += 1;
      }
    } else {
      missing.push(offer.name);
    }
  }

  const currentImported = [
    ...new Set(imported.currentNames.map(normalizeKauflandMatchName).filter(Boolean)),
  ];
  const unmatchedImportedCount = currentImported.filter(
    (name) => !kauflandNameMatches(name, officialNormalized),
  ).length;

  return {
    officialFoodishCount: analysis.officialFoodishCount,
    officialDistinctFoodCount: officialNormalized.length,
    matchedCount,
    matchedFilteredCount,
    matchedFilteredNonFoodCount,
    matchedFilteredUnconfirmedCount,
    missingEstimate: missing.length,
    missingExamples: missing.slice(0, maxExamples),
    unmatchedImportedCount,
    importedCurrentCount: matchedCount,
    comparisonScope: KAUFLAND_COMPARISON_SCOPE,
  };
}

function parseNormaProductBoxes(
  html: string,
  store: OfficialStoreConfig,
): RawOfferCandidate[] {
  const offers: RawOfferCandidate[] = [];
  const blocks = html.matchAll(
    /<article\b[^>]*class=["'][^"']*produktBoxContainer[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi,
  );

  for (const blockMatch of blocks) {
    const block = blockMatch[0];
    const name = stripHtml(
      block.match(/<h3\b[^>]*class=["'][^"']*produktBox-txt-headline[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i)?.[1] ??
        '',
    );
    const brand = stripHtml(
      block.match(/<strong\b[^>]*class=["'][^"']*supplier[^"']*["'][^>]*>([\s\S]*?)<\/strong>/i)?.[1] ??
        '',
    );
    const href = block.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1];
    const imageUrl = resolveUrl(
      getAttribute(block.match(/<img\b[^>]*>/i)?.[0] ?? '', 'src'),
      store.url,
    );
    const description = stripHtml(
      block.match(/<p\b[^>]*class=["'][^"']*produktBox-txt-description[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ??
        '',
    );
    const unit =
      stripHtml(
        block.match(/<li\b[^>]*class=["'][^"']*produktBox-txt-inh[^"']*["'][^>]*>([\s\S]*?)<\/li>/i)?.[1] ??
          '',
      ) || description;
    const baseParts = parseBasePriceText(
      stripHtml(
        block.match(/<li\b[^>]*class=["'][^"']*produktBox-txt-price[^"']*["'][^>]*>([\s\S]*?)<\/li>/i)?.[1] ??
          '',
      ),
    );
    const priceText =
      block.match(/aria-label=["']([\d.,]+)\s*Euro["']/i)?.[1] ??
      stripHtml(
        block.match(/produktBox-cont-wrapper-price[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] ??
          '',
      );
    const originalPrice = parseDecimal(
      stripHtml(
        block.match(/produktBox-cont-wrapper-uvp["'][^>]*>([\s\S]*?)<\/li>/i)?.[1] ?? '',
      ),
    );
    const dateMatch = decodeHtml(href ?? '').match(/(\d{2})\.(\d{2})\.(\d{2})/);
    const validityStart = dateMatch
      ? `20${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}T00:00:00.000Z`
      : undefined;

    const candidate = buildCandidate({
      storeChain: store.storeChain,
      name,
      brand: brand || undefined,
      price: parseDecimal(priceText),
      originalPrice,
      unit,
      basePrice: baseParts.basePrice,
      baseUnit: baseParts.baseUnit,
      imageUrl,
      sourceUrl: resolveUrl(href, store.url) ?? store.url,
      category: 'NORMA Angebote',
      validityStart,
      validityEnd: validityStart ? addDaysIso(validityStart, 6, true) : undefined,
      tags: originalPrice ? ['reduziert'] : [],
    });

    if (candidate) {
      offers.push(candidate);
    }
  }

  return offers;
}

function extractNormaOverviewPageUrls(
  html: string,
  store: OfficialStoreConfig,
): string[] {
  const urls = new Set<string>();
  const hrefs = html.matchAll(/href=["']([^"']*\/de\/angebote\/ab-[^"']+)["']/gi);

  for (const hrefMatch of hrefs) {
    const cleanHref = hrefMatch[1].split('?')[0];
    if (!/\/de\/angebote\/ab-[^/]+\/$/i.test(cleanHref)) {
      continue;
    }

    const url = resolveUrl(cleanHref, store.url);
    if (url) {
      urls.add(url);
    }
  }

  return [...urls].slice(0, 6);
}

function collectJsonLdProducts(
  value: unknown,
  out: RawOfferCandidate[],
  store: OfficialStoreConfig,
): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectJsonLdProducts(entry, out, store));
    return;
  }

  const record = value as Record<string, unknown>;
  const type = record['@type'];
  const types = Array.isArray(type) ? type : [type];
  const isProduct = types.some((entry) => String(entry).toLowerCase() === 'product');

  if (isProduct) {
    const rawOffers = record.offers;
    const offerRecord = Array.isArray(rawOffers) ? rawOffers[0] : rawOffers;
    const offers = offerRecord as Record<string, unknown> | undefined;
    const image = Array.isArray(record.image) ? record.image[0] : record.image;
    const candidate = buildCandidate({
      storeChain: store.storeChain,
      name: String(record.name ?? ''),
      brand: typeof record.brand === 'string' ? record.brand : undefined,
      price: parseDecimal(String(offers?.price ?? '')),
      imageUrl: resolveUrl(typeof image === 'string' ? image : undefined, store.url),
      sourceUrl: resolveUrl(String(record.url ?? ''), store.url) ?? store.url,
      category: typeof record.category === 'string' ? record.category : undefined,
    });
    if (candidate) {
      out.push(candidate);
    }
  }

  for (const child of Object.values(record)) {
    collectJsonLdProducts(child, out, store);
  }
}

function parseJsonLdProducts(html: string, store: OfficialStoreConfig): RawOfferCandidate[] {
  const offers: RawOfferCandidate[] = [];
  const scripts = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const script of scripts) {
    try {
      const parsed = JSON.parse(decodeHtml(script[1].trim())) as unknown;
      collectJsonLdProducts(parsed, offers, store);
    } catch {
      // Ignore invalid JSON-LD blocks from official pages.
    }
  }

  return offers;
}

/**
 * Index of the first occurrence of `className` as a COMPLETE CSS-class token.
 * A plain `indexOf` substring match is not enough: the Penny page renders a
 * category jump menu BEFORE the real week content whose containers use the
 * `…--current-week-menu` / `…--next-week-menu` class variants. Matching those
 * menu markers sliced an empty "current week" and attributed EVERY category
 * section to the next week (PENNY currentCount=0, all offers in nextWeek).
 */
function indexOfCssClassToken(html: string, className: string): number {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.search(new RegExp(`${escaped}(?![\\w-])`));
}

function extractPennyCategories(html: string): PennyCategoryRef[] {
  const weeksBlock = html.match(/<span[^>]+class=["']js-weeks["'][^>]*>/i)?.[0] ?? '';
  const currentWeek = getAttribute(weeksBlock, 'data-current-week');
  const nextWeek = getAttribute(weeksBlock, 'data-next-week');
  const currentStart = indexOfCssClassToken(html, 'tabs__content--current-week');
  const nextStart = indexOfCssClassToken(html, 'tabs__content--next-week');
  const sections: Array<{ week?: string; html: string }> = [];

  if (currentWeek && currentStart >= 0) {
    sections.push({
      week: currentWeek,
      html: html.slice(currentStart, nextStart >= 0 ? nextStart : undefined),
    });
  }

  if (nextWeek && nextStart >= 0) {
    sections.push({
      week: nextWeek,
      html: html.slice(nextStart),
    });
  }

  const refs = new Map<string, PennyCategoryRef>();
  for (const section of sections) {
    if (!section.week) {
      continue;
    }

    const categoryBlocks = section.html.matchAll(
      /<section\b[^>]*class=["'][^"']*js-category-section[^"']*["'][^>]*data-period-category=["']false["'][^>]*>/gi,
    );
    for (const categoryBlock of categoryBlocks) {
      const block = categoryBlock[0];
      const categoryName = getAttribute(block, 'data-category-name');
      const categoryType = getAttribute(block, 'data-category-type') ?? '';
      if (!categoryName || categoryType !== 'food') {
        continue;
      }
      const key = `${section.week}|${categoryName}`;
      refs.set(key, {
        week: section.week,
        categoryName,
        categoryType,
      });
    }
  }

  return [...refs.values()];
}

function parsePennyProductData(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parsePennyOfferTile(
  tile: PennyOfferTile,
  store: OfficialStoreConfig,
  category: PennyCategoryRef,
): RawOfferCandidate | null {
  const productData = parsePennyProductData(tile.productData);
  const name = textValue(tile.title);
  const priceText = textValue(tile.price) ?? textValue(tile.benefitPrice);
  const originalPriceText =
    textValue(tile.originalPrice) ??
    textValue(tile.crossOutPrice) ??
    textValue(tile.listPrice);
  const baseParts = parseBasePriceText(textValue(tile.basePrice));
  const imageUrl = resolveUrl(
    textValue(tile.imageRendition?.tileMd) ??
      textValue(tile.imageRendition?.tileLg) ??
      textValue(tile.imageRendition?.tileXl),
    store.url,
  );
  const sourceUrl = resolveUrl(
    textValue(tile.linkHref) ?? textValue(tile.detailLinkHref),
    store.url,
  ) ?? store.url;
  const validity = validityForIsoWeek(category.week);
  const categoryLabel = String(productData.category ?? category.categoryName);

  return buildCandidate({
    storeChain: store.storeChain,
    name: name ?? '',
    price: parseDecimal(priceText),
    originalPrice: parseDecimal(originalPriceText),
    unit: textValue(tile.quantity),
    basePrice: baseParts.basePrice,
    baseUnit: baseParts.baseUnit,
    imageUrl,
    sourceUrl,
    category: categoryLabel,
    validityStart: validity?.start,
    validityEnd: validity?.end,
  });
}

function parseOfficialOffersFromHtml(
  html: string,
  store: OfficialStoreConfig,
): RawOfferCandidate[] {
  const jsonLdOffers = parseJsonLdProducts(html, store);
  let storeSpecificOffers: RawOfferCandidate[] = [];
  if (store.parser === 'aldi') {
    storeSpecificOffers = parseAldiProductTiles(html, store);
  } else if (store.parser === 'aldiNord') {
    storeSpecificOffers = parseAldiNordApiData(html, store);
  } else if (store.parser === 'edeka') {
    storeSpecificOffers = parseEdekaOffers(html, store).offers;
  } else if (store.parser === 'kaufland') {
    storeSpecificOffers = parseKauflandOffersFromHtml(html, store);
  } else if (store.parser === 'lidl') {
    storeSpecificOffers = [
      ...parseLidlProductGridData(html, store),
      ...parseLidlImageAltOffers(html, store),
    ];
  } else if (store.parser === 'netto') {
    storeSpecificOffers = parseNettoProductTiles(html, store);
  } else if (store.parser === 'norma') {
    storeSpecificOffers = parseNormaProductBoxes(html, store);
  }

  const byId = new Map<string, RawOfferCandidate>();
  for (const offer of [...jsonLdOffers, ...storeSpecificOffers]) {
    if (offer.id) {
      byId.set(offer.id, offer);
    }
  }
  return [...byId.values()];
}

async function fetchOfficialText(
  url: string,
  options: {
    accept: string;
    referer?: string;
    timeoutMs?: number;
    /** Zusätzliche/überschreibende Header (z. B. Accept-Language). */
    headers?: Record<string, string>;
  },
): Promise<string> {
  await waitForRateLimit();

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, options.timeoutMs ?? appConfig.officialOffersTimeoutMs);
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: options.accept,
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
        ...(options.referer ? { Referer: options.referer } : {}),
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        ...(options.headers ?? {}),
      },
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const hasBotChallenge = /captcha|challenge|access denied|zugriff verweigert/i.test(
        errorBody,
      );
      const challengeText = hasBotChallenge ? ' (Captcha/Anti-Bot)' : '';
      throw new Error(
        `${response.status} ${response.statusText}${challengeText}`.trim(),
      );
    }

    return response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timeout nach ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Wie {@link fetchOfficialText}, aber wirft NICHT bei non-2xx — gibt Status,
 *  Content-Type und Body zurück, damit ein 403/Blockade pro Quelle ehrlich als
 *  `blocked` diagnostiziert werden kann (kein stilles „0 Angebote"). Dieselbe
 *  Rate-Limit-Disziplin + Browser-Header; KEIN Anti-Bot-Bypass. */
async function fetchOfficialResponse(
  url: string,
  options: { accept: string; referer?: string; timeoutMs?: number },
): Promise<{
  status: number;
  contentType?: string;
  body: string;
  blocked: boolean;
  blockReason?: string;
}> {
  await waitForRateLimit();

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, options.timeoutMs ?? appConfig.officialOffersTimeoutMs);
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: options.accept,
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
        ...(options.referer ? { Referer: options.referer } : {}),
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    const body = await response.text();
    let blockReason: string | undefined;
    if (!response.ok) {
      const hasBotChallenge = /captcha|challenge|access denied|zugriff verweigert/i.test(
        body,
      );
      blockReason = `${response.status} ${response.statusText}${
        hasBotChallenge ? ' (Captcha/Anti-Bot)' : ''
      }`.trim();
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? undefined,
      body,
      blocked: !response.ok,
      blockReason,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timeout nach ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Binär-Fetch für regulär öffentliche Bildassets (Lidl-Prospekt-OCR). Nutzt
 *  dieselbe Rate-Limit-Disziplin + Browser-Header wie {@link fetchOfficialText};
 *  KEIN Login-/Captcha-/Anti-Bot-Bypass, lädt nur, was die Angebotsseite ohnehin
 *  öffentlich referenziert. */
async function fetchOfficialBinary(
  url: string,
  options: { referer?: string; timeoutMs?: number; accept?: string } = {},
): Promise<Uint8Array> {
  await waitForRateLimit();
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, options.timeoutMs ?? appConfig.officialOffersTimeoutMs);
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Default bevorzugt moderne Formate (WebP/AVIF); Aufrufer, die canvas-
        // dekodierbare Bytes brauchen, setzen `accept: 'image/jpeg,image/png'`
        // (Content-Negotiation OHNE URL-/Signaturänderung).
        Accept: options.accept ?? 'image/avif,image/webp,image/png,image/jpeg,*/*',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
        ...(options.referer ? { Referer: options.referer } : {}),
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timeout nach ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchOfficialHtml(store: OfficialStoreConfig): Promise<string> {
  const timeoutMs =
    store.parser === 'aldiNord' || store.parser === 'kaufland'
      ? Math.max(appConfig.officialOffersTimeoutMs, 30000)
      : appConfig.officialOffersTimeoutMs;
  return fetchOfficialText(store.url, {
    accept: 'text/html,application/xhtml+xml',
    timeoutMs,
  });
}

async function fetchPennyCategoryOffers(
  store: OfficialStoreConfig,
  category: PennyCategoryRef,
): Promise<RawOfferCandidate[]> {
  const url = resolveUrl(
    `/.rest/offers/by-category/${encodeURIComponent(category.week)}/${encodeURIComponent(category.categoryName)}`,
    store.url,
  );
  if (!url) {
    return [];
  }

  const jsonText = await fetchOfficialText(url, {
    accept: 'application/json,text/plain,*/*',
    referer: store.url,
  });
  const parsed = JSON.parse(jsonText) as { offerTiles?: PennyOfferTile[] };
  const tiles = Array.isArray(parsed.offerTiles) ? parsed.offerTiles : [];

  return tiles
    .map((tile) => parsePennyOfferTile(tile, store, category))
    .filter((offer): offer is RawOfferCandidate => Boolean(offer));
}

async function fetchPennyOffers(
  html: string,
  store: OfficialStoreConfig,
  warnings: string[],
): Promise<RawOfferCandidate[]> {
  const categories = extractPennyCategories(html);
  const maxRequests = Math.max(0, Math.floor(appConfig.officialOffersMaxCategoryRequests));
  const limitedCategories = categories.slice(0, maxRequests || categories.length);
  const offers: RawOfferCandidate[] = [];

  if (limitedCategories.length < categories.length) {
    warnings.push(
      `${store.storeChain}: ${categories.length - limitedCategories.length} Kategorien wegen OFFICIAL_OFFERS_MAX_CATEGORY_REQUESTS uebersprungen.`,
    );
  }

  for (const category of limitedCategories) {
    try {
      offers.push(...(await fetchPennyCategoryOffers(store, category)));
    } catch (error) {
      if (error instanceof Error && /\b404\b/.test(error.message)) {
        continue;
      }

      warnings.push(
        `${store.storeChain}: Kategorie ${category.week}/${category.categoryName} konnte nicht gelesen werden (${
          error instanceof Error ? error.message : 'unbekannter Fehler'
        }).`,
      );
    }
  }

  return offers;
}

/**
 * ALDI SÜD strukturiert importieren: die zentrale Wochenangebote-Sammelseite mit
 * Pagination (Seite 1 = Basis-URL, danach ?page=2,3,…) fetchen (status-erhaltend,
 * kein Throw bei 403), pro Seite die __NUXT_DATA__-Produkte parsen (DOM-Kachel-
 * Fallback nur bei echtem HTML 200), über alle Seiten dedupen + die Diagnose
 * setzen. Kein PDF/OCR/Vision, kein Anti-Bot-Bypass. Eine blockierte Seite wird
 * ehrlich erfasst — nie als „0 Angebote" verschluckt.
 */
async function fetchAldiSuedOffers(
  store: OfficialStoreConfig,
  warnings: string[],
  now: Date = new Date(),
): Promise<RawOfferCandidate[]> {
  const fetchPage: AldiSuedPageFetcher = async (url) => {
    try {
      const response = await fetchOfficialResponse(url, {
        accept: 'text/html,application/xhtml+xml',
        referer: store.url,
        timeoutMs: Math.max(appConfig.officialOffersTimeoutMs, 30000),
      });
      const isHtml = /text\/html/i.test(response.contentType ?? '');
      if (response.blocked || !isHtml) {
        return {
          url,
          label: ALDI_SUED_COLLECTION_SOURCE.label,
          ok: false,
          status: response.status,
          contentType: response.contentType,
          blockReason:
            response.blockReason ??
            (isHtml ? `HTTP ${response.status}` : `kein HTML (${response.contentType ?? '?'})`),
        };
      }
      return {
        url,
        label: ALDI_SUED_COLLECTION_SOURCE.label,
        ok: true,
        status: response.status,
        contentType: response.contentType,
        html: response.body,
      };
    } catch (error) {
      return {
        url,
        label: ALDI_SUED_COLLECTION_SOURCE.label,
        ok: false,
        blockReason: error instanceof Error ? error.message : 'unbekannter Fehler',
      };
    }
  };

  const { offers, diagnostics } = await collectAldiSuedPaginatedOffers(fetchPage, store, now);
  if (!diagnostics.lastSuccessfulAt && lastAldiSuedDiagnostics?.lastSuccessfulAt) {
    diagnostics.lastSuccessfulAt = lastAldiSuedDiagnostics.lastSuccessfulAt;
  }
  lastAldiSuedDiagnostics = diagnostics;

  if (offers.length === 0) {
    warnings.push(
      diagnostics.blocked
        ? `${store.storeChain}: Wochenangebote-Sammelseite blockiert/nicht erreichbar — kein strukturierter Import.`
        : `${store.storeChain}: Sammelseite erreichbar, aber 0 strukturierte Produkte importiert — Quelle/Parser prüfen.`,
    );
  } else {
    const blockedPages = diagnostics.sourceUrlsChecked.filter((source) => source.blocked);
    for (const source of blockedPages) {
      warnings.push(
        `${store.storeChain}: Seite ${source.page ?? '?'} (${source.url}) blockiert (${source.blockReason ?? 'unbekannt'}) — Teilimport.`,
      );
    }
  }

  return dedupeOffersById(offers);
}

// How many weekly Aktionsprospekte to fetch (current + next week is enough for
// the live/next buckets; a third future week would only bloat the snapshot).
const LIDL_MAX_LEAFLETS = 2;

/** Failure warning for a leaflet that resolved but yielded 0 products. 0 products
 *  is NEVER a silent success; the scan gate additionally blocks the commit when
 *  the total Lidl volume collapses.
 *
 *  Hinweis: Ein `latest-leaflet-…`-Identifier ist KEIN Indiz für diesen Fall —
 *  siehe {@link LIDL_LATEST_LEAFLET_IDENTIFIER}, er liefert den vollen laufenden
 *  Prospekt. Die frühere Gleichsetzung „latest-leaflet = leerer Teaser" war ein
 *  Trugschluss und darf nicht wieder eingebaut werden. */
export function lidlLeafletEmptyWarning(storeChain: string, identifier: string): string {
  return `${storeChain}: Prospekt "${identifier}" lieferte 0 Produkte — Quelle prüfen.`;
}

/** OCR/Vision-Modi für EINEN `fetchLidlLeafletOffers`-Aufruf — optional, damit
 *  bestehende Aufrufer (der Live-Scan) unverändert `'off'`/`'off'` bekommen.
 *  Genutzt vom separaten, manuellen Lidl-Bildseiten-Import (siehe
 *  `lidlPageOfferImport.ts`); der automatische Wochen-Scan lässt dieses Argument
 *  weg und verhält sich exakt wie vorher. */
export interface LidlProspectModes {
  ocrMode?: LidlOcrMode;
  visionMode?: LidlOcrMode;
  imageLimit?: number;
}

export async function fetchLidlLeafletOffers(
  html: string,
  store: OfficialStoreConfig,
  warnings: string[],
  diagnostics: SubSourceDiagnostic[],
  prospectModes?: LidlProspectModes,
): Promise<RawOfferCandidate[]> {
  const discovered = extractLidlLeafletIdentifiers(html);
  const identifiers = resolveLidlLeafletIdentifiers(discovered);
  if (discovered.length === 0) {
    // Discovery gebrochen — aber KEIN Abbruch mehr: der permanente Identifier
    // trägt die laufende Woche weiter. Der Befund bleibt als Warnung + Diagnose
    // sichtbar, damit ein Markup-Wechsel nicht still unter den Tisch fällt.
    warnings.push(
      `${store.storeChain}: kein Aktionsprospekt-Identifier auf der Prospektseite gefunden — ` +
        'Wochenangebote kommen aus dem permanenten Prospekt-Identifier, Folgewochen fehlen.',
    );
    diagnostics.push(
      buildSubSourceDiagnostic({
        storeChain: store.storeChain,
        sourceId: `${store.storeChain.toLowerCase()}:prospektseite`,
        status: 'parse_failed',
        urlOrSlug: store.url,
        rawCount: 0,
        resultCount: 0,
        errorCode: 'no_leaflet_identifier',
        note: 'Kein Aktionsprospekt-Identifier auf der Prospektseite — permanenter Identifier greift.',
      }),
    );
  }

  const offers: RawOfferCandidate[] = [];
  // Gesehene Flyer-Identitäten: der garantierte permanente Identifier und der
  // datierte Slug derselben Woche liefern denselben Prospekt. Ohne diese Sperre
  // zählte die Subquellen-Diagnose ihn doppelt.
  const gesehenerFlyer = new Set<string>();
  for (const identifier of identifiers) {
    // Stabiler Subquellen-/Prospekt-Identifier + erwartetes Gültigkeitsfenster
    // (Task P5): erlaubt dem Safety-Gate, einen Teilverlust GENAU diesem Prospekt
    // zuzuordnen, ohne KW-Sonderlogik.
    const sourceId = `${store.storeChain.toLowerCase()}:${identifier}`;
    const expectedStart = ymdToIsoStart(lidlLeafletIdentifierStartYmd(identifier));
    const expectedEnd = isoPlusDays(expectedStart, 6);
    const url = `https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=${encodeURIComponent(identifier)}`;
    let jsonText: string;
    try {
      jsonText = await fetchOfficialText(url, {
        accept: 'application/json,text/plain,*/*',
        referer: store.url,
        timeoutMs: Math.max(appConfig.officialOffersTimeoutMs, 30000),
      });
    } catch (error) {
      warnings.push(
        `${store.storeChain}: Prospekt-JSON "${identifier}" konnte nicht gelesen werden (${
          error instanceof Error ? error.message : 'unbekannter Fehler'
        }).`,
      );
      diagnostics.push(
        buildSubSourceDiagnostic({
          storeChain: store.storeChain,
          sourceId,
          status: 'fetch_failed',
          urlOrSlug: identifier,
          expectedValidityStart: expectedStart,
          expectedValidityEnd: expectedEnd,
          rawCount: 0,
          resultCount: 0,
          errorCode: 'leaflet_fetch_failed',
          note: error instanceof Error ? error.message : 'unbekannter Fehler',
        }),
      );
      continue;
    }
    let leafletOffers: RawOfferCandidate[];
    let parsedFlyer: unknown = null;
    let prospectPages: LidlProspectPageEvidence = {
      pageCount: 0,
      imageCount: 0,
      imageExamples: [],
      imageUrls: [],
    };
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      parsedFlyer = parsed;
      // Doppelten Prospekt still überspringen: derselbe Flyer wurde bereits über
      // einen anderen Identifier gelesen (permanent + datiert zeigen in der
      // laufenden Woche auf dieselbe `flyer.id`). Die Angebote von dort sind
      // schon gezählt — ein zweiter Durchlauf verdoppelte nur die Diagnose.
      const flyerId = readLidlFlyerId(parsed);
      if (flyerId !== null) {
        if (gesehenerFlyer.has(flyerId)) {
          continue;
        }
        gesehenerFlyer.add(flyerId);
      }
      // Strukturierter Beleg: wie viele Prospekt-BILDSEITEN trägt der Flyer, die
      // NICHT als strukturierte Produkte vorliegen (OCR-Kandidaten)?
      prospectPages = detectLidlProspectPages(parsed);
      const noImageSink = { skippedNoImage: 0 };
      leafletOffers = parseLidlLeafletProducts(parsed, store, noImageSink).map((offer) => ({
        ...offer,
        sourceId,
      }));
      if (noImageSink.skippedNoImage > 0) {
        warnings.push(
          `${store.storeChain}: ${noImageSink.skippedNoImage} strukturierte(s) Produkt(e) im Prospekt "${identifier}" ` +
            'ohne Bild übersprungen — ohne Belegbild nie automatisch live (Review-Import deckt sie ab).',
        );
      }
    } catch (error) {
      warnings.push(
        `${store.storeChain}: Prospekt-JSON "${identifier}" konnte nicht geparst werden (${
          error instanceof Error ? error.message : 'unbekannter Fehler'
        }).`,
      );
      diagnostics.push(
        buildSubSourceDiagnostic({
          storeChain: store.storeChain,
          sourceId,
          status: 'parse_failed',
          urlOrSlug: identifier,
          expectedValidityStart: expectedStart,
          expectedValidityEnd: expectedEnd,
          rawCount: 0,
          resultCount: 0,
          errorCode: 'leaflet_parse_failed',
          note: error instanceof Error ? error.message : 'unbekannter Fehler',
        }),
      );
      continue;
    }
    if (leafletOffers.length === 0) {
      // 0 products is an HONEST empty result — diagnosed, but NOT a technical
      // failure on its own (the total-volume gate still blocks a real collapse).
      warnings.push(lidlLeafletEmptyWarning(store.storeChain, identifier));
      diagnostics.push(
        buildSubSourceDiagnostic({
          storeChain: store.storeChain,
          sourceId,
          status: 'empty',
          urlOrSlug: identifier,
          expectedValidityStart: expectedStart,
          expectedValidityEnd: expectedEnd,
          rawCount: 0,
          resultCount: 0,
        }),
      );
    } else {
      diagnostics.push(
        buildSubSourceDiagnostic({
          storeChain: store.storeChain,
          sourceId,
          status: 'success',
          urlOrSlug: identifier,
          expectedValidityStart: expectedStart,
          expectedValidityEnd: expectedEnd,
          rawCount: leafletOffers.length,
          resultCount: leafletOffers.length,
        }),
      );
    }

    offers.push(...leafletOffers);

    // Viewer-Hotspot-Bilanz (Task Lidl-Auto-Scan): wie viele Hotspots trägt der
    // Prospekt, wie viele davon sind strukturiert bepreist (importierbar) und
    // wie viele bleiben preislos pending? Reine 'empty'-Diagnosezeile — sie
    // blockiert nie und schaltet nie etwas live.
    const hotspotDiagnostic = buildLidlViewerHotspotDiagnostic({
      store,
      identifier,
      sourceId,
      summary: summarizeLidlViewerHotspots(parsedFlyer),
      expectedValidityStart: expectedStart,
      expectedValidityEnd: expectedEnd,
    });
    if (hotspotDiagnostic) diagnostics.push(hotspotDiagnostic);

    // Prospektseiten-Beleg + OCR-Bilanz GEMEINSAM über die getestete, injizierbare
    // Funktion emittieren (Single Source of Truth). Der OCR-Modus wird EXPLIZIT
    // durchgereicht (nicht tief im Connector aus dem beim Modul-Import
    // eingefrorenen `appConfig` gelesen) — so ist der Pfad testbar UND kann nicht
    // mehr durch eine zu früh erfasste Config still auf 'off' kippen, während die
    // an pageCount gebundene :prospektseiten-Zeile weiterhin erscheint.
    const prospect = await assembleLidlProspectDiagnostics({
      store,
      identifier,
      parsedFlyer,
      prospectPages,
      leafletOffers,
      // Auto-Scan muss schnell und deterministisch bleiben: die stabile Viewer-
      // JSON-products-Map ist die automatische Quelle. OCR/Vision ueber
      // Prospektbilder ist standardmaessig aus ('off'/'off', wenn der Aufrufer
      // kein `prospectModes` uebergibt) — sonst kann ein einzelner Lidl-Store-
      // Fetch trotz strukturierter Produkte in den harten 90s-Timeout laufen und
      // als 0-Angebote-Lauf zurueckkommen. Der separate, manuelle Lidl-
      // Bildseiten-Import (lidlPageOfferImport.ts) uebergibt hier explizit
      // 'live'/'diagnostic' o.ä. — der automatische Wochen-Scan lässt
      // `prospectModes` weg und bleibt exakt beim bisherigen Verhalten.
      ocrMode: prospectModes?.ocrMode ?? 'off',
      visionMode: prospectModes?.visionMode ?? 'off',
      imageLimit: prospectModes?.imageLimit,
      warnings,
    });
    diagnostics.push(...prospect.diagnostics);
    offers.push(...prospect.emittedOffers);
  }

  return dedupeOffersById(offers);
}

export interface AssembleLidlProspectDiagnosticsInput {
  store: OfficialStoreConfig;
  /** Prospekt-Identifier (Slug) dieser Subquelle. */
  identifier: string;
  /** Geparstes Flyer-JSON (für den OCR-Lauf + Gültigkeitsableitung). */
  parsedFlyer: unknown;
  /** Strukturell erkannte Prospekt-Bildseiten (aus {@link detectLidlProspectPages}). */
  prospectPages: LidlProspectPageEvidence;
  /** Bereits strukturiert importierte Angebote DIESES Prospekts (Dedupe-Ziel). */
  leafletOffers: readonly RawOfferCandidate[];
  /** EXPLIZITER OCR-Modus dieses Laufs (vom Aufrufer aus appConfig gelesen). */
  ocrMode: LidlOcrMode;
  /** EXPLIZITER VISION-Modus dieses Laufs (separater Pfad NEBEN dem OCR-Pfad).
   *  Default 'off' (kein Vision-Pfad) — so bleiben bestehende Aufrufer/Tests
   *  unverändert. Der reale Connector reicht appConfig.lidlVisionMode durch. */
  visionMode?: LidlOcrMode;
  /** Connector-Warnungssammler (ein OCR-Fehler wird hier ehrlich vermerkt). */
  warnings: string[];
  /** Injizierbar für Tests; Default = reale tesseract-OCR + öffentlicher Fetch. */
  ocrImage?: (imageBytes: Uint8Array, imageUrl: string) => Promise<string>;
  /** OPTIONALE Layoutanalyse je Bild (Wortboxen) — injizierbar für Tests. */
  ocrLayout?: (imageBytes: Uint8Array, imageUrl: string) => Promise<OcrLayoutPage | null>;
  /** Injizierbarer Vision-Adapter (Tests: Fake; Default = lokales Ollama-Modell). */
  analyzeVisionImage?: AnalyzeLidlProspectImage;
  fetchBinary?: (url: string) => Promise<Uint8Array>;
  imageLimit?: number;
  /** DEBUG-EVIDENCE-Sink (injizierbar für Tests; sonst real bei aktiver Config). */
  recordPageEvidence?: (evidence: LidlOcrPageEvidence) => void;
  /** DEBUG-EVIDENCE-Sink für den Vision-Pfad (injizierbar für Tests). */
  recordVisionPageEvidence?: (evidence: LidlVisionPageEvidence) => void;
  debugEvidencePath?: string;
  debugEvidenceLimit?: number;
}

/**
 * Baut die beiden Prospekt-Belegzeilen eines Lidl-Prospekts GEMEINSAM und gibt
 * sie an den Connector zurück (er pusht sie in dasselbe Diagnose-Array wie die
 * strukturierte Produktzeile → Pipeline → Safety-Gate → Report):
 *
 *  1. `:prospektseiten` — sobald `pageCount > 0`: die Bildseiten tragen
 *     strukturell 0 Produkte (OCR-Beleg, status `empty`, blockiert nie).
 *  2. `:prospektseiten:ocr` — sobald `ocrMode !== 'off' && pageCount > 0`: die
 *     ehrliche OCR-Bilanz (auch wenn KEINE ladbaren Bild-URLs existieren → dann
 *     attempted 0 + Übersprungen-Grund). `diagnostic` schaltet NICHTS live,
 *     `live` gibt nur die sicheren Kandidaten frei (zentraler Food-Gate bleibt
 *     die letzte Instanz). Ein OCR-Fehlschlag wird als Warnung vermerkt und
 *     bricht den Scrape nie.
 *
 * Der OCR-Modus ist ein Parameter (keine tief verborgene globale Config-Lesung),
 * damit die Verdrahtung end-to-end testbar ist und nicht still auf 'off' kippen
 * kann, während `:prospektseiten` weiterhin erscheint.
 */
export async function assembleLidlProspectDiagnostics(
  input: AssembleLidlProspectDiagnosticsInput,
): Promise<{ diagnostics: SubSourceDiagnostic[]; emittedOffers: RawOfferCandidate[] }> {
  const { store, identifier, prospectPages, ocrMode } = input;
  const diagnostics: SubSourceDiagnostic[] = [];
  const emittedOffers: RawOfferCandidate[] = [];
  if (prospectPages.pageCount <= 0) {
    return { diagnostics, emittedOffers };
  }

  const sourceId = `${store.storeChain.toLowerCase()}:${identifier}`;
  // Eigene Subquellenzeile mit eindeutigem ":prospektseiten"-sourceId (kein
  // Angebot trägt diese Id, daher 0/0-Bilanz) und KEIN Gültigkeitsfenster, damit
  // die echten Prospektangebote dieser Belegzeile nicht zugeordnet werden.
  const ocrModeNote =
    ocrMode === 'off'
      ? 'OCR über die Prospektseiten erforderlich (LIDL_OCR_MODE=off — nicht aktiv).'
      : `OCR-Pfad aktiv (LIDL_OCR_MODE=${ocrMode}) — siehe :prospektseiten:ocr-Bilanz.`;
  diagnostics.push(
    buildSubSourceDiagnostic({
      storeChain: store.storeChain,
      sourceId: `${sourceId}:prospektseiten`,
      status: 'empty',
      urlOrSlug: identifier,
      rawCount: prospectPages.imageCount,
      resultCount: 0,
      note:
        `${prospectPages.pageCount} Prospekt-Bildseiten / ${prospectPages.imageCount} Bildassets erkannt, ` +
        `strukturell 0 Lebensmittelangebote daraus — ${ocrModeNote}`,
    }),
  );

  // Generischer OCR-/Prospektbild-Pfad (hinter LIDL_OCR_MODE, Default off):
  // Gate auf pageCount (NICHT imageUrls.length) — sobald der Prospekt überhaupt
  // Bildseiten trägt, MUSS im diagnostic/live-Modus eine ehrliche
  // :prospektseiten:ocr-Bilanzzeile entstehen, auch ohne ladbare CDN-Bild-URLs.
  if (ocrMode !== 'off') {
    try {
      const ocr = await runLidlLeafletOcr({
        parsedFlyer: input.parsedFlyer,
        store,
        sourceId,
        structuredOffers: input.leafletOffers,
        mode: ocrMode,
        ocrImage: input.ocrImage,
        ocrLayout: input.ocrLayout,
        fetchBinary: input.fetchBinary,
        imageLimit: input.imageLimit,
        recordPageEvidence: input.recordPageEvidence,
        debugEvidencePath: input.debugEvidencePath,
        debugEvidenceLimit: input.debugEvidenceLimit,
      });
      if (ocr) {
        diagnostics.push(ocr.diagnostic);
        emittedOffers.push(...ocr.emittedOffers);
      }
    } catch (error) {
      input.warnings.push(
        `${store.storeChain}: OCR-Prospektpfad für "${identifier}" fehlgeschlagen (${
          error instanceof Error ? error.message : 'unbekannter Fehler'
        }).`,
      );
    }
  }

  // Generischer VISION-Prospektbild-Pfad (hinter LIDL_VISION_MODE, Default off) —
  // ein SEPARATER, kontrollierter Pfad NEBEN dem OCR-Pfad. diagnostic: nur die
  // Bilanzzeile, keine Offers; live: sichere Kandidaten zusätzlich (sie durchlaufen
  // dieselbe zentrale Food-/Non-Food-Sicherheit wie OCR). Ein Fehlschlag wird als
  // Warnung vermerkt und bricht den Scrape nie.
  const visionMode = input.visionMode ?? 'off';
  if (visionMode !== 'off') {
    try {
      const vision = await runLidlLeafletVision({
        parsedFlyer: input.parsedFlyer,
        store,
        sourceId,
        structuredOffers: input.leafletOffers,
        mode: visionMode,
        analyzeVisionImage: input.analyzeVisionImage,
        fetchBinary: input.fetchBinary,
        imageLimit: input.imageLimit,
        recordPageEvidence: input.recordVisionPageEvidence,
      });
      if (vision) {
        diagnostics.push(vision.diagnostic);
        emittedOffers.push(...vision.emittedOffers);
      }
    } catch (error) {
      input.warnings.push(
        `${store.storeChain}: Vision-Prospektpfad für "${identifier}" fehlgeschlagen (${
          error instanceof Error ? error.message : 'unbekannter Fehler'
        }).`,
      );
    }
  }

  return { diagnostics, emittedOffers };
}

/** Aus dem Flyer-JSON abgeleitetes Gültigkeitsfenster (NICHT geraten) — dieselben
 *  Felder, die {@link parseLidlLeafletProducts} für die strukturierten Produkte
 *  nutzt. */
function lidlFlyerValidity(parsed: unknown): { start?: string; end?: string } {
  const flyer = isRecord(parsed) && isRecord(parsed.flyer) ? parsed.flyer : undefined;
  if (!flyer) {
    return {};
  }
  return {
    start:
      dateOnlyToIso(textValue(flyer.offerStartDate)) ?? dateOnlyToIso(textValue(flyer.startDate)),
    end:
      dateOnlyToIso(textValue(flyer.offerEndDate), true) ??
      dateOnlyToIso(textValue(flyer.endDate), true),
  };
}

export interface RunLidlLeafletOcrInput {
  /** Das geparste Flyer-JSON (für detectLidlProspectPages + Flyer-Gültigkeit). */
  parsedFlyer: unknown;
  store: OfficialStoreConfig;
  sourceId: string;
  /** Bereits strukturiert importierte Angebote DIESES Prospekts (Dedupe-Ziel). */
  structuredOffers: readonly RawOfferCandidate[];
  mode: 'diagnostic' | 'live';
  /** Injizierbar für Tests; Default = reale tesseract-OCR + öffentlicher Fetch. */
  ocrImage?: (imageBytes: Uint8Array, imageUrl: string) => Promise<string>;
  /** OPTIONALE Layoutanalyse je Bild (Wortboxen) — injizierbar für Tests. */
  ocrLayout?: (imageBytes: Uint8Array, imageUrl: string) => Promise<OcrLayoutPage | null>;
  /** OPTIONALE Preisbox-Crop-OCR — injizierbar für Tests; Default = reale canvas/
   *  tesseract-Crop-Glue, wenn der Crop-Modus aktiv ist. */
  cropPriceOcr?: PriceCropOcr;
  fetchBinary?: (url: string) => Promise<Uint8Array>;
  imageLimit?: number;
  /** DEBUG-EVIDENCE-Sink, injizierbar für Tests. Ist er gesetzt, wird KEIN realer
   *  Datei-Writer erzeugt (Tests sammeln in-memory). */
  recordPageEvidence?: (evidence: LidlOcrPageEvidence) => void;
  /** Debug-Pfad-Referenz (nur für die Note) bei injiziertem Sink. */
  debugEvidencePath?: string;
  /** Obergrenze der Debug-Seiten (Default = appConfig.lidlOcrDebugLimit). */
  debugEvidenceLimit?: number;
}

/**
 * Connector-Glue für den Lidl-Prospektbild-OCR: sammelt die regulär öffentlichen
 * Prospekt-Bild-URLs, leitet die Gültigkeit aus dem Flyer ab, nutzt die
 * bestehende Connector-Non-Food-Signalliste als Food-/Non-Food-Gate (kein neuer
 * Allowlist) und delegiert an den getesteten {@link runLidlProspectOcr}-Kern.
 * Gibt null zurück, wenn der Prospekt keine OCR-fähigen Bildseiten trägt.
 */
export async function runLidlLeafletOcr(
  input: RunLidlLeafletOcrInput,
): Promise<RunLidlProspectOcrResult | null> {
  const evidence = detectLidlProspectPages(input.parsedFlyer);
  // null NUR, wenn der Prospekt strukturell gar keine Bildseiten trägt (nichts zu
  // OCR-en). Trägt er Bildseiten, aber keine direkt ladbaren Bild-URLs, läuft der
  // Pfad trotzdem durch und liefert eine ehrliche 0-Bilanz (attempted 0 +
  // Übersprungen-Grund), damit der diagnostic-Modus im Report sichtbar ist.
  if (evidence.pageCount === 0) {
    return null;
  }
  const validity = lidlFlyerValidity(input.parsedFlyer);
  // Reale Scans: ocrImage + ocrLayout teilen EINEN tesseract-Lauf je Bild (Memo),
  // damit der layout-aware Kartenextraktor zusätzlich Wortboxen bekommt, ohne das
  // Bild doppelt zu OCR-en. In Tests wird ocrImage (und ggf. ocrLayout) injiziert →
  // dann läuft KEINE Default-Layoutanalyse (Verhalten der bestehenden Tests bleibt).
  const realPair = !input.ocrImage && !input.ocrLayout ? createDefaultLidlOcrPair() : null;

  const cropMode = appConfig.lidlOcrPriceCropMode;

  // Debug-Evidence: ein injizierter Sink (Tests) gewinnt; sonst — und NUR wenn
  // LIDL_OCR_DEBUG_EVIDENCE gesetzt ist — wird ein realer Datei-Writer erzeugt, der
  // je Seite ein git-ignoriertes JSON-Artefakt schreibt. Der reine Beleg-Pfad ist
  // damit gebaut; ein echter Full-Scan füllt ihn mit reproduzierbaren Fixtures.
  // VOR dem Crop-Pair erzeugt, damit der reale Crop-OCR seine optionalen Crop-Preview-
  // PNGs in `<evidenceDir>/crops/` schreiben kann (nur DEBUG, nie Snapshot).
  let evidenceWriter: LidlOcrEvidenceWriter | null = null;
  let recordPageEvidence = input.recordPageEvidence;
  let debugEvidencePath = input.debugEvidencePath;
  const debugEvidenceLimit = input.debugEvidenceLimit ?? appConfig.lidlOcrDebugLimit;
  if (!recordPageEvidence && appConfig.lidlOcrDebugEvidence) {
    const runId = `${input.store.storeChain.toLowerCase()}-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}`;
    evidenceWriter = createLidlOcrEvidenceWriter({ runId, limit: appConfig.lidlOcrDebugLimit });
    recordPageEvidence = evidenceWriter.recordPageEvidence;
    debugEvidencePath = evidenceWriter.evidenceDir;
  }

  // Preisbox-Crop-Pass: nur aktiv, wenn der Crop-Modus != off ist. Eine injizierte
  // cropPriceOcr (Tests) gewinnt; sonst — und NUR im aktiven Modus — wird die reale
  // canvas/tesseract-Crop-Glue erzeugt (eigener Worker, am Ende terminiert). Der
  // Crop-Pass hängt am Layout-Pfad (Wortboxen) → braucht ein ocrLayout. Ist der
  // Debug-Evidence-Writer aktiv, bekommt die reale Glue dessen Crop-Preview-Sink.
  const realCropPair =
    cropMode !== 'off' && !input.cropPriceOcr
      ? createDefaultPriceCropOcr({ previewWriter: evidenceWriter?.writeCropPreview })
      : null;

  const ocrResult = await runLidlProspectOcr({
    imageUrls: evidence.imageUrls,
    prospectPageCount: evidence.pageCount,
    context: {
      storeChain: input.store.storeChain,
      sourceUrl: input.store.url,
      sourceId: input.sourceId,
      validityStart: validity.start,
      validityEnd: validity.end,
      existingNameKeys: input.structuredOffers.map((offer) => normalizeText(offer.name)),
    },
    mode: input.mode,
    ocrImage: input.ocrImage ?? realPair?.ocrImage ?? defaultLidlOcrImage,
    ocrLayout: input.ocrLayout ?? realPair?.ocrLayout,
    cropPriceOcr: input.cropPriceOcr ?? realCropPair?.cropOcr,
    priceCropMode: cropMode,
    cropOptions: { limitPerPage: appConfig.lidlOcrPriceCropLimit },
    fetchBinary:
      input.fetchBinary ?? ((url) => fetchOfficialBinary(url, { referer: input.store.url })),
    imageLimit: input.imageLimit ?? appConfig.lidlOcrImageLimit,
    recordPageEvidence,
    debugEvidencePath,
    debugEvidenceLimit,
    options: {
      // Bestehende Connector-Non-Food-Keywordliste (kein neuer Allowlist); der
      // nachgelagerte zentrale Food-Gate bleibt die letzte Instanz.
      classifyNonFood: ({ name }) =>
        containsNormalized(normalizeText(name), lidlAltNonFoodKeywords),
    },
  });
  // Auf das Schreiben der Debug-Artefakte warten, bevor wir zurückkehren (sonst
  // könnte der Prozess vor dem Flush enden). Best-effort: Schreibfehler werfen nie.
  await evidenceWriter?.flush();
  // Den realen Crop-Worker (falls erzeugt) terminieren — best-effort.
  await realCropPair?.dispose();
  return ocrResult;
}

export interface RunLidlLeafletVisionInput {
  /** Das geparste Flyer-JSON (für detectLidlProspectPages + Flyer-Gültigkeit). */
  parsedFlyer: unknown;
  store: OfficialStoreConfig;
  sourceId: string;
  /** Bereits strukturiert importierte Angebote DIESES Prospekts (Dedupe-Ziel). */
  structuredOffers: readonly RawOfferCandidate[];
  mode: 'diagnostic' | 'live';
  /** Injizierbarer Vision-Adapter (Tests: Fake; Default = lokales Ollama-Modell). */
  analyzeVisionImage?: AnalyzeLidlProspectImage;
  /** Injizierbarer Tiler (Tests: synthetisch; Default = canvas, sofern tileMode grid). */
  tileImage?: LidlVisionImageTiler;
  fetchBinary?: (url: string) => Promise<Uint8Array>;
  /** Injizierbarer Rendition-Fetch für canvas-inkompatible Bilder (WebP/AVIF → JPEG). */
  fetchCanvasRendition?: (url: string) => Promise<Uint8Array>;
  imageLimit?: number;
  /** DEBUG-EVIDENCE-Sink, injizierbar für Tests. Ist er gesetzt, wird KEIN realer
   *  Datei-Writer erzeugt (Tests sammeln in-memory). */
  recordPageEvidence?: (evidence: LidlVisionPageEvidence) => void;
}

/**
 * Connector-Glue für den Lidl-Prospektbild-VISION-Import: sammelt die regulär
 * öffentlichen Prospekt-Bild-URLs (dieselben, die der OCR-Pfad kennt), leitet die
 * Gültigkeit aus dem Flyer ab, nutzt die bestehende Connector-Non-Food-Signalliste
 * als zusätzliches Food-/Non-Food-Gate (kein neuer Allowlist) und delegiert an den
 * getesteten {@link runLidlVisionProspectImport}-Kern. Gibt null zurück, wenn der
 * Prospekt keine Bildseiten trägt. Der reale Vision-Adapter (Ollama) wird nur
 * erzeugt, wenn kein Adapter injiziert ist.
 */
export async function runLidlLeafletVision(
  input: RunLidlLeafletVisionInput,
): Promise<RunLidlVisionImportResult | null> {
  const evidence = detectLidlProspectPages(input.parsedFlyer);
  if (evidence.pageCount === 0) {
    return null;
  }
  const validity = lidlFlyerValidity(input.parsedFlyer);

  // Tiling-Strategie aus der Config (Default 'grid' — behebt den Full-Page-Timeout des
  // kleinen lokalen Vision-Modells). Der reale canvas-Tiler wird nur erzeugt, wenn kein
  // Tiler injiziert ist und tileMode 'grid' aktiv ist.
  const tileMode = appConfig.lidlVisionTileMode;
  const tileTimeoutMs = appConfig.lidlVisionTileTimeoutMs;
  const tileImage: LidlVisionImageTiler | undefined =
    input.tileImage ?? (tileMode === 'grid' ? createDefaultLidlVisionImageTiler() : undefined);

  // Debug-Evidence: ein injizierter Sink (Tests) gewinnt; sonst — und NUR wenn
  // LIDL_VISION_DEBUG_EVIDENCE gesetzt ist — ein realer, git-ignorierter Datei-Writer.
  let evidenceWriter: LidlVisionEvidenceWriter | null = null;
  let recordPageEvidence = input.recordPageEvidence;
  let recordTilePreview:
    | ((preview: { imageUrl: string; imageUrlTail: string; tile: VisionTileImage }) => void)
    | undefined;
  let debugEvidencePath: string | undefined;
  if (!recordPageEvidence && appConfig.lidlVisionDebugEvidence) {
    const runId = `${input.store.storeChain.toLowerCase()}-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}`;
    evidenceWriter = createLidlVisionEvidenceWriter({
      runId,
      limit: appConfig.lidlVisionDebugLimit,
      // Tile-Preview-Bilder nur im Debug-Modus, beschränkt auf das Debug-Seitenbudget.
      previewLimit: appConfig.lidlVisionTileLimit * appConfig.lidlVisionDebugLimit,
    });
    recordPageEvidence = evidenceWriter.recordPageEvidence;
    recordTilePreview = evidenceWriter.recordTilePreview;
    debugEvidencePath = evidenceWriter.evidenceDir;
  }

  const analyzeVisionImage =
    input.analyzeVisionImage ??
    createDefaultLidlVisionAdapter({
      host: appConfig.ollamaHost,
      model: appConfig.lidlVisionModel,
      // Im Tile-Modus besitzt der Runner den per-Tile-Timer (Abbruch via Signal); der
      // Adapter-Timeout muss GRÖSSER sein, damit nicht er zuerst (als modelUnavailable)
      // feuert. Im Full-Page-Modus gilt der normale Ollama-Timeout.
      timeoutMs: tileMode === 'grid' ? tileTimeoutMs + 5000 : appConfig.ollamaTimeoutMs,
      // Modell-Last begrenzen: kurzes JSON (num_predict) + optionales top_p — der Haupthebel
      // gegen den Tile-Timeout neben dem kurzen Tile-Prompt.
      numPredict: appConfig.lidlVisionNumPredict,
      topP: appConfig.lidlVisionTopP >= 0 ? appConfig.lidlVisionTopP : undefined,
    });

  const result = await runLidlVisionProspectImport({
    imageUrls: evidence.imageUrls,
    prospectPageCount: evidence.pageCount,
    context: {
      storeChain: input.store.storeChain,
      sourceUrl: input.store.url,
      sourceId: input.sourceId,
      validityStart: validity.start,
      validityEnd: validity.end,
      existingNameKeys: input.structuredOffers.map((offer) => normalizeText(offer.name)),
    },
    mode: input.mode,
    analyzeImage: analyzeVisionImage,
    modelName: appConfig.lidlVisionModel,
    fetchBinary:
      input.fetchBinary ?? ((url) => fetchOfficialBinary(url, { referer: input.store.url })),
    // node-canvas dekodiert kein WebP/AVIF. Für die Tile-Rendition eine JPEG/PNG-
    // bevorzugende Rendition DERSELBEN öffentlichen Quelle laden (Content-Negotiation
    // über den Accept-Header — keine URL-/Signaturänderung, keine private API).
    fetchCanvasRendition:
      input.fetchCanvasRendition ??
      ((url) =>
        fetchOfficialBinary(url, { referer: input.store.url, accept: 'image/jpeg,image/png' })),
    imageLimit: input.imageLimit ?? appConfig.lidlVisionImageLimit,
    // ── Tiling (Default grid; behebt den Full-Page-Timeout) ──
    tileMode,
    tileImage,
    tilePlanOptions: {
      columns: appConfig.lidlVisionTileColumns,
      rows: appConfig.lidlVisionTileRows,
      overlap: appConfig.lidlVisionTileOverlap,
      limit: appConfig.lidlVisionTileLimit,
      // 0 = aus (adaptives Raster); > 0 erzwingt kleinere Tiles (weniger Inhalt pro Call).
      maxTileWidth: appConfig.lidlVisionTileMaxWidth > 0 ? appConfig.lidlVisionTileMaxWidth : undefined,
      maxTileHeight: appConfig.lidlVisionTileMaxHeight > 0 ? appConfig.lidlVisionTileMaxHeight : undefined,
    },
    tileTimeoutMs,
    // Subtile-Fallback: nur im diagnostic-Lauf (Sicherheit/Budget) und nur, wenn aktiviert.
    subtileFallback: appConfig.lidlVisionSubtileFallback && input.mode === 'diagnostic',
    subtileLimit: appConfig.lidlVisionSubtileLimit,
    recordTilePreview,
    recordPageEvidence,
    debugEvidencePath,
    debugEvidenceLimit: appConfig.lidlVisionDebugLimit,
    options: {
      // Bestehende Connector-Non-Food-Keywordliste (kein neuer Allowlist); der
      // nachgelagerte zentrale Food-Gate bleibt die letzte Instanz.
      classifyNonFood: ({ name }) =>
        containsNormalized(normalizeText(name), lidlAltNonFoodKeywords),
      // Strenge Modell-Antwort-Qualität (Sprache/Datum/Evidenz/Einheit/Markenname) VOR
      // dem Safety-Gate erzwingen — verwirft die belegten llava:7b-Halluzinationen mit
      // eigener, nachvollziehbarer Lens (modelQualityRejectedByReason). KEINE Allowlist.
      enforceModelQuality: true,
    },
  });
  await evidenceWriter?.flush();
  return result;
}

async function fetchNormaOffers(
  html: string,
  store: OfficialStoreConfig,
  warnings: string[],
): Promise<RawOfferCandidate[]> {
  const offers = [...parseNormaProductBoxes(html, store)];
  const urls = extractNormaOverviewPageUrls(html, store);

  for (const url of urls) {
    try {
      const pageHtml = await fetchOfficialText(url, {
        accept: 'text/html,application/xhtml+xml',
        referer: store.url,
        timeoutMs: Math.max(appConfig.officialOffersTimeoutMs, 30000),
      });
      offers.push(...parseNormaProductBoxes(pageHtml, { ...store, url }));
    } catch (error) {
      warnings.push(
        `${store.storeChain}: Angebotsseite ${url} konnte nicht gelesen werden (${
          error instanceof Error ? error.message : 'unbekannter Fehler'
        }).`,
      );
    }
  }

  return dedupeOffersById(offers);
}

function parseHitValidity(html: string): { start?: string; end?: string } {
  const match = stripHtml(html).match(
    /G[üu]ltig\s+vom\s+(\d{1,2})\.(\d{1,2})\s*-\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/i,
  );
  if (!match) {
    return {};
  }

  const year = match[5];
  const start = `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}T00:00:00.000Z`;
  const end = `${year}-${match[4].padStart(2, '0')}-${match[3].padStart(2, '0')}T23:59:59.999Z`;
  return { start, end };
}

function parseHitArticle(
  article: HitArticle,
  store: OfficialStoreConfig,
  validity: { start?: string; end?: string },
): RawOfferCandidate | null {
  const priceTag = isRecord(article.priceTag) ? article.priceTag : {};
  const baseParts = parseBasePriceText(
    textValue(priceTag.basePriceText) ?? textValue(priceTag.appBasePriceText),
  );
  const image = isRecord(article.image) ? article.image : {};
  const labels = Array.isArray(article.labels)
    ? article.labels
        .filter(isRecord)
        .map((label) => textValue(label.label) ?? textValue(label.name))
        .filter((label): label is string => Boolean(label))
    : [];
  const offerCount = Number(priceTag.offerCount ?? 0);

  return buildCandidate({
    storeChain: store.storeChain,
    name: textValue(article.headline) ?? '',
    price: parseDecimal(numberText(article.price)),
    originalPrice:
      parseDecimal(numberText(article.recommendedPrice)) ??
      parseDecimal(textValue(priceTag.priceStrikeThroughText)),
    unit: textValue(article.overview),
    basePrice: baseParts.basePrice,
    baseUnit: baseParts.baseUnit,
    imageUrl: resolveUrl(
      textValue(image.desktop) ?? textValue(image.tablet) ?? textValue(image.mobile),
      store.url,
    ),
    sourceUrl: resolveUrl(textValue(article.url), store.url) ?? store.url,
    category: labels[0] ?? 'HIT Angebote',
    validityStart: validity.start,
    validityEnd: validity.end,
    tags: offerCount > 0 ? ['hit-angebot'] : [],
  });
}

async function fetchHitOffers(
  html: string,
  store: OfficialStoreConfig,
): Promise<RawOfferCandidate[]> {
  const url = resolveUrl('/api/v2/assortment/article?for_store=&page=0&limit=60', store.url);
  if (!url) {
    return [];
  }

  const jsonText = await fetchOfficialText(url, {
    accept: 'application/json,text/plain,*/*',
    referer: store.url,
  });
  const parsed = JSON.parse(jsonText) as { data?: HitArticle[] };
  const validity = parseHitValidity(html);

  return (Array.isArray(parsed.data) ? parsed.data : [])
    .map((article) => parseHitArticle(article, store, validity))
    .filter((offer): offer is RawOfferCandidate => Boolean(offer));
}

// Last Kaufland completeness snapshot, captured opportunistically during a
// scrape (when the HTML is in hand) so the post-scan report can show official
// vs imported without re-fetching. Best-effort: never throws into the scrape.
let lastKauflandAnalysis: KauflandSsrAnalysis | null = null;
let lastKauflandCompleteness: KauflandCompleteness | null = null;

export function getLastKauflandAnalysis(): KauflandSsrAnalysis | null {
  return lastKauflandAnalysis;
}

export function getLastKauflandCompleteness(): KauflandCompleteness | null {
  return lastKauflandCompleteness;
}

function captureKauflandCompleteness(
  html: string,
  importedOffers: RawOfferCandidate[],
  warnings: string[],
): void {
  try {
    const analysis = analyzeKauflandSsr(html);
    // Scrape-Zeit-Sicht: nach Bucket + nonfood-Tag getrennt, dieselben
    // Metrik-Definitionen wie der Report (der nach dem Scan zusätzlich gegen
    // den ECHTEN Snapshot rechnet — siehe buildScanVerificationReport).
    const food = importedOffers.filter((offer) => !(offer.tags ?? []).includes('nonfood'));
    const completeness = buildKauflandCompleteness(analysis, {
      currentNames: food
        .filter((offer) => classifyOfferBucket(offer) === 'current')
        .map((offer) => offer.name),
      nextWeekNames: food
        .filter((offer) => classifyOfferBucket(offer) === 'upcoming')
        .map((offer) => offer.name),
      filteredNonFoodNames: importedOffers
        .filter((offer) => (offer.tags ?? []).includes('nonfood'))
        .map((offer) => offer.name),
    });
    lastKauflandAnalysis = analysis;
    lastKauflandCompleteness = completeness;

    if (completeness.missingEstimate > 0) {
      const examples = completeness.missingExamples.slice(0, 8).join(', ');
      warnings.push(
        `Kaufland Vollständigkeit: ${completeness.matchedCount}/${completeness.officialDistinctFoodCount} distinct food-Angebote der aktuellen Woche importiert, ~${completeness.missingEstimate} fehlen.` +
          (examples ? ` Beispiele: ${examples}.` : ''),
      );
    }
  } catch {
    // Completeness is a diagnostic — a parse hiccup must never break the scrape.
  }
}

// EDEKA-Import-Diagnose zur Scrape-Zeit erfassen (analog Kaufland): setzt die
// maschinenlesbare Zählkette + blocked/empty-Status, ohne erneut zu fetchen.
// Ein erfolgreicher Lauf (≥1 Angebot) trägt lastSuccessfulAt; ein blockierter
// oder layout-geänderter Lauf wird ehrlich markiert. Best-effort: bricht den
// Scrape nie ab.
function captureEdekaDiagnostics(
  html: string,
  store: OfficialStoreConfig,
  warnings: string[],
): void {
  try {
    const { offers, diagnostics } = parseEdekaOffers(html, store);
    // Erfolgreiche Verifikation über Prozess-Neustarts hinweg behalten: ein
    // späterer 0-/Block-Lauf darf den letzten Erfolgszeitpunkt nicht löschen.
    if (!diagnostics.lastSuccessfulAt && lastEdekaDiagnostics?.lastSuccessfulAt) {
      diagnostics.lastSuccessfulAt = lastEdekaDiagnostics.lastSuccessfulAt;
    }
    lastEdekaDiagnostics = diagnostics;

    if (offers.length === 0) {
      warnings.push(
        diagnostics.blocked
          ? `${store.storeChain}: Angebotsseite blockiert (${diagnostics.blockReason ?? 'Block-Seite'}) — keine Angebote lesbar, alter Bestand bleibt erhalten.`
          : diagnostics.pageLooksLikeOffers
            ? `${store.storeChain}: Seite erreichbar, aber 0 Angebote geparst (${diagnostics.offerBlocks} Karten, ${diagnostics.rejectedExamples.length} abgelehnt) — Parser/Quelle prüfen.`
            : `${store.storeChain}: keine bekannte Angebots-Struktur auf der Seite — Layout evtl. geändert.`,
      );
    } else if (diagnostics.withOfferPrice < diagnostics.candidates) {
      const rejected = diagnostics.candidates - diagnostics.withOfferPrice;
      warnings.push(
        `${store.storeChain}: ${offers.length} nationale Angebote importiert, ${rejected} Karte(n) ohne echten Angebotspreis verworfen (z. B. nur PAYBACK-Punkte/Normalpreis).`,
      );
    }
  } catch {
    // Diagnose darf den Scrape nie brechen.
  }
}

/** Per-Store-Fetcher-Signatur (für den Test-Seam austauschbar). */
type FetchStoreOffersFn = (
  store: OfficialStoreConfig,
  warnings: string[],
  diagnostics: SubSourceDiagnostic[],
) => Promise<RawOfferCandidate[]>;

/** Ergebnis eines per äußerem Timeout/Abort abgesicherten Store-Fetches.
 *  Unterscheidet einen HARTEN Timeout und einen ABORT (Cancel/Pause) klar vom
 *  normalen Erfolg/Fehler, damit ein Cancel nie wie ein Store-Timeout-Warning
 *  aussieht. Echte Fetch-Fehler werden weitergeworfen (bestehende catch-Logik). */
type GuardedStoreFetch =
  | { kind: 'ok'; offers: RawOfferCandidate[] }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/**
 * Legt einen harten äußeren Timeout (und das Abbruchsignal) um EINEN
 * Store-Fetch — unabhängig von den inneren fetch/OCR/Vision-Timeouts. Hängt der
 * Store (resolved nie), gewinnt der Timer; bricht der Scan ab, gewinnt das Signal.
 * In beiden Fällen kehrt der Aufrufer sofort zurück und macht mit dem nächsten
 * Store weiter — der hängende innere Promise bleibt zwar pending, blockiert aber
 * NICHTS mehr (er wird nicht mehr abgewartet).
 */
async function fetchStoreOffersGuarded(
  run: () => Promise<RawOfferCandidate[]>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<GuardedStoreFetch> {
  if (signal?.aborted) {
    return { kind: 'aborted' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<GuardedStoreFetch>((resolve, reject) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      if (signal) {
        onAbort = () => resolve({ kind: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
      }
      run().then(
        (offers) => resolve({ kind: 'ok', offers }),
        (error) => reject(error),
      );
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

async function fetchStoreOffers(
  store: OfficialStoreConfig,
  warnings: string[],
  diagnostics: SubSourceDiagnostic[],
): Promise<RawOfferCandidate[]> {
  // ALDI SÜD: KEIN Landing-Fetch — der strukturierte Connector lädt direkt die
  // zentrale Wochenangebote-Sammelseite mit Pagination (__NUXT_DATA__),
  // status-erhaltend + diagnostiziert.
  if (store.parser === 'aldi') {
    return fetchAldiSuedOffers(store, warnings);
  }
  // nahkauf: die Angebotsseite kann 404 sein (Angebote nur noch via rewe.de) —
  // Token-Fallback über die Startseite statt Store-Fehlschlag.
  const html =
    store.parser === 'nahkauf'
      ? await fetchNahkaufHtmlWithFallback(store, warnings)
      : await fetchOfficialHtml(store);
  const htmlOffers = parseOfficialOffersFromHtml(html, store);
  if (store.parser === 'kaufland') {
    captureKauflandCompleteness(html, htmlOffers, warnings);
  }
  if (store.parser === 'edeka') {
    captureEdekaDiagnostics(html, store, warnings);
  }
  if (store.parser === 'aldiNord') {
    captureAldiNordDiagnostics(html, store, warnings);
  }
  const additionalOffers =
    store.parser === 'penny'
      ? await fetchPennyOffers(html, store, warnings)
      : store.parser === 'hit'
        ? await fetchHitOffers(html, store)
        : store.parser === 'lidl'
          ? await fetchLidlLeafletOffers(html, store, warnings, diagnostics)
          : store.parser === 'nahkauf'
            ? await fetchNahkaufOffers(html, store, warnings)
            : store.parser === 'norma'
              ? await fetchNormaOffers(html, store, warnings)
              : [];

  const byId = new Map<string, RawOfferCandidate>();
  for (const offer of [...htmlOffers, ...additionalOffers]) {
    if (offer.id) {
      byId.set(offer.id, offer);
    }
  }

  return [...byId.values()];
}

export interface OfficialSupermarketConnectorOptions {
  /** Store chains to skip entirely (case-insensitive), e.g. REWE/nahkauf for
   *  the weekly auto-scan — they 403/captcha and stay file-import only. */
  excludeStoreChains?: readonly string[];
  /** Harter Per-Store-Timeout (ms). Default {@link appConfig.storeFetchTimeoutMs}
   *  (90 s). Äußerer Schutz um fetchStoreOffers, unabhängig von den inneren
   *  fetch/OCR/Vision-Timeouts. Ein Store, der das überschreitet, wird als
   *  fetch_failed (store_fetch_timeout) erfasst, der Scan läuft weiter. */
  storeFetchTimeoutMs?: number;
  /** Test-Seam: ersetzt den Per-Store-Fetcher (Default: echtes fetchStoreOffers),
   *  damit der Schleifen-/Timeout-/Abort-Pfad ohne Netzwerk testbar ist. */
  fetchStoreOffersImpl?: FetchStoreOffersFn;
}

export class OfficialSupermarketSourceConnector implements SourceConnector {
  public readonly id = 'official-supermarket-offers';
  public readonly displayName = 'Offizielle Supermarkt-Websites';
  private lastWarnings: string[] = [];
  private lastSubSourceDiagnostics: SubSourceDiagnostic[] = [];
  private readonly excludedChains: ReadonlySet<string>;
  private readonly storeFetchTimeoutMs: number;
  private readonly fetchStoreOffersImpl: FetchStoreOffersFn;

  public constructor(options: OfficialSupermarketConnectorOptions = {}) {
    this.excludedChains = new Set(
      (options.excludeStoreChains ?? [])
        .map((chain) => String(chain).trim().toLowerCase())
        .filter((chain) => chain.length > 0),
    );
    // Floor nur gegen 0/negativ (Sofort-Timeout aller Stores). Der konservative
    // Produktions-Default (90 s, min. 1 s) wird bereits in appConfig erzwungen;
    // ein explizit injizierter kleiner Wert (Tests) bleibt erhalten.
    this.storeFetchTimeoutMs = Math.max(
      1,
      Math.round(options.storeFetchTimeoutMs ?? appConfig.storeFetchTimeoutMs),
    );
    this.fetchStoreOffersImpl = options.fetchStoreOffersImpl ?? fetchStoreOffers;
  }

  public async fetchRawContent(): Promise<RawSourceDocument[]> {
    return [];
  }

  public getLastWarnings(): string[] {
    return this.lastWarnings;
  }

  public getLastSubSourceDiagnostics(): SubSourceDiagnostic[] {
    return this.lastSubSourceDiagnostics;
  }

  public async fetchRawOffers(
    locationFilter: LocationFilter,
    _tryOllama?: boolean,
    runtime?: SourceConnectorRuntime,
  ): Promise<RawOfferCandidate[]> {
    const activeStores = selectOfficialStores([...this.excludedChains]);
    const cacheKey = JSON.stringify({
      locationFilter,
      // Exclusions change the result, so they must be part of the cache key —
      // otherwise a filtered run could reuse a full-run cache (or vice versa).
      stores: activeStores.map((store) => store.url),
    });
    const now = Date.now();

    if (
      cacheEntry &&
      cacheEntry.key === cacheKey &&
      now - cacheEntry.createdAt < appConfig.ingestCacheTtlMs
    ) {
      this.lastWarnings = cacheEntry.warnings;
      this.lastSubSourceDiagnostics = cacheEntry.subSourceDiagnostics;
      return cacheEntry.offers;
    }

    const offers: RawOfferCandidate[] = [];
    const warnings: string[] = [];
    const subSourceDiagnostics: SubSourceDiagnostic[] = [];
    const signal = runtime?.signal;
    const total = activeStores.length;

    for (let index = 0; index < activeStores.length; index += 1) {
      const store = activeStores[index];
      const position = `${index + 1}/${total}`;

      // Cancel/Pause: sauber stoppen, BEVOR der nächste Store startet — kein
      // Store-Timeout/Warning, kein stiller Hintergrund-Commit.
      if (signal?.aborted) {
        break;
      }

      runtime?.onStoreProgress?.({
        storeChain: store.storeChain,
        parser: store.parser,
        index: index + 1,
        total,
        phase: 'start',
      });
      const startedAt = Date.now();
      console.info(
        `[OfficialSupermarketSourceConnector] store fetch start ${position} ${store.storeChain} parser=${store.parser}`,
      );

      try {
        const storeWarnings: string[] = [];
        const storeSubSourceDiagnostics: SubSourceDiagnostic[] = [];
        const guarded = await fetchStoreOffersGuarded(
          () => this.fetchStoreOffersImpl(store, storeWarnings, storeSubSourceDiagnostics),
          this.storeFetchTimeoutMs,
          signal,
        );
        const durationMs = Date.now() - startedAt;

        // Abbruch (Cancel/Pause): sauberer Stopp, KEIN Warning/Timeout-Diagnostic.
        if (guarded.kind === 'aborted') {
          console.info(
            `[OfficialSupermarketSourceConnector] store fetch aborted ${position} ${store.storeChain} durationMs=${durationMs}`,
          );
          break;
        }

        // Harter Per-Store-Timeout: als fetch_failed (store_fetch_timeout) erfassen,
        // Warning setzen, mit dem nächsten Store weitermachen — nie den Scan
        // einfrieren lassen.
        if (guarded.kind === 'timeout') {
          const note = `Hard-Timeout nach ${this.storeFetchTimeoutMs}ms — Store übersprungen, Scan läuft weiter.`;
          warnings.push(`${store.storeChain}: ${note}`);
          subSourceDiagnostics.push(
            buildSubSourceDiagnostic({
              storeChain: store.storeChain,
              sourceId: `${store.storeChain.toLowerCase()}:angebotsseite`,
              status: 'fetch_failed',
              urlOrSlug: store.url,
              rawCount: 0,
              resultCount: 0,
              errorCode: 'store_fetch_timeout',
              note,
            }),
          );
          if (store.parser === 'edeka') {
            recordEdekaFetchFailure(store, new Error('store_fetch_timeout'));
          }
          if (store.parser === 'aldiNord') {
            recordAldiNordFetchFailure(store, new Error('store_fetch_timeout'));
          }
          if (store.parser === 'aldi') {
            recordAldiSuedFetchFailure(store, new Error('store_fetch_timeout'));
          }
          if (store.parser === 'nahkauf') {
            recordNahkaufFetchFailure(store, new Error('store_fetch_timeout'));
          }
          runtime?.onStoreProgress?.({
            storeChain: store.storeChain,
            parser: store.parser,
            index: index + 1,
            total,
            phase: 'timeout',
            durationMs,
          });
          console.warn(
            `[OfficialSupermarketSourceConnector] store fetch timeout ${position} ${store.storeChain} parser=${store.parser} durationMs=${durationMs} offerCount=0`,
          );
          continue;
        }

        const storeOffers = guarded.offers;
        warnings.push(...storeWarnings);
        subSourceDiagnostics.push(...storeSubSourceDiagnostics);
        if (storeOffers.length === 0) {
          warnings.push(`${store.storeChain}: keine Angebote im offiziellen HTML gefunden.`);
        }
        offers.push(...storeOffers);
        runtime?.onStoreProgress?.({
          storeChain: store.storeChain,
          parser: store.parser,
          index: index + 1,
          total,
          phase: 'success',
          durationMs,
          offerCount: storeOffers.length,
        });
        console.info(
          `[OfficialSupermarketSourceConnector] store fetch success ${position} ${store.storeChain} parser=${store.parser} durationMs=${durationMs} offerCount=${storeOffers.length}`,
        );
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        if (store.parser === 'edeka') {
          recordEdekaFetchFailure(store, error);
        }
        if (store.parser === 'aldiNord') {
          recordAldiNordFetchFailure(store, error);
        }
        if (store.parser === 'aldi') {
          recordAldiSuedFetchFailure(store, error);
        }
        if (store.parser === 'nahkauf') {
          recordNahkaufFetchFailure(store, error);
        }
        warnings.push(
          `${store.storeChain}: offizielle Angebotsseite konnte nicht gelesen werden (${
            error instanceof Error ? error.message : 'unbekannter Fehler'
          }).`,
        );
        // Eine komplett unlesbare Store-Seite ist ein expliziter Fehlschlag der
        // gesamten Store-Subquelle (Task P5) — strukturiert, nicht aus Text.
        subSourceDiagnostics.push(
          buildSubSourceDiagnostic({
            storeChain: store.storeChain,
            sourceId: `${store.storeChain.toLowerCase()}:angebotsseite`,
            status: 'fetch_failed',
            urlOrSlug: store.url,
            rawCount: 0,
            resultCount: 0,
            errorCode: 'store_page_fetch_failed',
            note: error instanceof Error ? error.message : 'unbekannter Fehler',
          }),
        );
        runtime?.onStoreProgress?.({
          storeChain: store.storeChain,
          parser: store.parser,
          index: index + 1,
          total,
          phase: 'failure',
          durationMs,
        });
        console.warn(
          `[OfficialSupermarketSourceConnector] store fetch failure ${position} ${store.storeChain} parser=${store.parser} durationMs=${durationMs} error=${
            error instanceof Error ? error.message : 'unbekannter Fehler'
          }`,
        );
      }
    }

    if (warnings.length > 0) {
      console.warn(`[OfficialSupermarketSourceConnector] ${warnings.join(' | ')}`);
    }

    // Ein abgebrochener Lauf darf keinen partiellen Cache hinterlassen — sonst
    // liefert der nächste Lauf still einen unvollständigen Cache-Treffer.
    if (!signal?.aborted) {
      cacheEntry = {
        key: cacheKey,
        offers,
        warnings,
        subSourceDiagnostics,
        createdAt: Date.now(),
      };
    }
    this.lastWarnings = warnings;
    this.lastSubSourceDiagnostics = subSourceDiagnostics;
    return offers;
  }
}

export const officialSupermarketTestApi = {
  resetCache: resetOfficialOffersCacheForTests,
  selectOfficialStores,
  parseOfficialOffersFromHtml,
  parseEdekaOffers,
  parseLidlProductGridData,
  parseLidlLeafletProducts,
  summarizeLidlViewerHotspots,
  buildLidlViewerHotspotDiagnostic,
  detectLidlProspectPages,
  runLidlLeafletOcr,
  assembleLidlProspectDiagnostics,
  extractLidlLeafletIdentifier,
  extractLidlLeafletIdentifiers,
  resolveLidlLeafletIdentifiers,
  readLidlFlyerId,
  isLidlLeafletNonFoodCategory,
  lidlLeafletEmptyWarning,
  parseNahkaufStoryblokOffers,
  extractNahkaufStoryblokToken,
  dedupeNahkaufOffers,
  fetchNahkaufHtmlWithFallback,
  fetchNahkaufOffers,
  buildNahkaufZeroOffersWarning,
  parseNettoProductTiles,
  parseAldiNordApiData,
  parseAldiNordOffers,
  getLastAldiNordDiagnostics,
  extractAldiSuedOfferPageUrls,
  parseAldiSuedPage,
  aggregateAldiSuedPages,
  collectAldiSuedPaginatedOffers,
  aldiSuedPageUrl,
  getLastAldiSuedDiagnostics,
  parseAldiSuedSaleDate,
  parseKauflandOffersFromHtml,
  analyzeKauflandSsr,
  buildKauflandCompleteness,
  normalizeKauflandMatchName,
  splitKauflandCardPrefix,
  isKauflandNonFoodCategory,
  isKauflandFoodCategory,
  parseNormaProductBoxes,
  extractNormaOverviewPageUrls,
  extractPennyCategories,
  parsePennyOfferTile,
};
