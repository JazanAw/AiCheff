// canvas (native binding) + tesseract.js (OCR runtime) are heavy to load and
// only used when actually OCR-ing a local-market prospect image. Import them
// lazily at first use so they don't slow every backend start (this connector is
// constructed at startup). Promises are cached → each module loads once.
type CanvasModule = typeof import('canvas');
type TesseractModule = typeof import('tesseract.js');

let canvasModulePromise: Promise<CanvasModule> | null = null;
let tesseractModulePromise: Promise<TesseractModule> | null = null;

function loadCanvasModule(): Promise<CanvasModule> {
  return (canvasModulePromise ??= import('canvas'));
}
function loadTesseractModule(): Promise<TesseractModule> {
  return (tesseractModulePromise ??= import('tesseract.js'));
}
import { appConfig } from '../../src/config/env';
import type { LocationFilter } from '../../src/types/models';
import { toSimpleOfferCategory } from '../../src/utils/offerCategory';
import { normalizeText } from '../../src/utils/offers';
import type { RawOfferCandidate, RawSourceDocument, SourceConnector } from '../../src/services/offersIngest/types';
import { NominatimGeocoder } from './geocoding';
import {
  localMarketRegistry,
  selectLocalMarketsForLocation,
  type LocalMarketConfig,
  type LocalMarketWithDistance,
} from './localMarkets';

interface ProspectRef {
  url: string;
  label: string;
  validityStart?: string;
  validityEnd?: string;
}

interface CacheEntry {
  key: string;
  offers: RawOfferCandidate[];
  warnings: string[];
  createdAt: number;
}

type FetchLike = typeof fetch;
type OcrImageFn = (imageBuffer: Buffer, imageUrl: string) => Promise<string>;

let cacheEntry: CacheEntry | null = null;
let lastRequestAt = 0;

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
    euro: 'EUR',
    uuml: 'ü',
    Uuml: 'Ü',
    ouml: 'ö',
    Ouml: 'Ö',
    auml: 'ä',
    Auml: 'Ä',
    szlig: 'ß',
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

function resolveUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(decodeHtml(value), baseUrl).toString();
  } catch {
    return undefined;
  }
}

function dateToIso(year: number, month: number, day: number, endOfDay = false): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (endOfDay) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date.toISOString();
}

function parseGermanDateRange(
  value: string,
  now = new Date(),
): { start: string; end: string } | undefined {
  const text = decodeHtml(value);
  const dottedMatch = text.match(
    /(\d{1,2})\.(\d{1,2})\.?\s*(?:bis|-|–|&#8211;)\s*(\d{1,2})\.(\d{1,2})\.?(?:\s*(\d{4}))?/i,
  );
  const slugMatch = text.match(
    /(?:^|[^\d])(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{4})(?:[^\d]|$)/,
  );
  const match = dottedMatch ?? slugMatch;
  if (!match) {
    return undefined;
  }

  const startDay = Number(match[1]);
  const startMonth = Number(match[2]);
  const endDay = Number(match[3]);
  const endMonth = Number(match[4]);
  const startYear = Number(match[5] ?? now.getFullYear());
  const endYear = endMonth < startMonth ? startYear + 1 : startYear;

  if (
    !Number.isFinite(startDay) ||
    !Number.isFinite(startMonth) ||
    !Number.isFinite(endDay) ||
    !Number.isFinite(endMonth) ||
    !Number.isFinite(startYear)
  ) {
    return undefined;
  }

  return {
    start: dateToIso(startYear, startMonth, startDay),
    end: dateToIso(endYear, endMonth, endDay, true),
  };
}

function stableLocalOfferId(
  storeId: string,
  name: string,
  price: number,
  validityStart: string,
): string {
  const source = `${storeId}|${normalizeText(name)}|${price}|${validityStart}`;
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash << 5) - hash + source.charCodeAt(index);
    hash |= 0;
  }
  return `local_${Math.abs(hash).toString(36)}`;
}

function cleanOcrLine(value: string): string {
  return value
    .replace(/\u00ad/g, '')
    .replace(/[|_]+/g, ' ')
    .replace(/[€]/g, ' EUR ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDateRangeLine(value: string): boolean {
  return /\d{1,2}\.\d{1,2}\.?\s*(?:bis|-|–)\s*\d{1,2}\.\d{1,2}/i.test(value);
}

function isIgnoredOcrLine(value: string): boolean {
  const normalized = normalizeText(value);
  return (
    normalized.length < 2 ||
    isDateRangeLine(value) ||
    /^(angebote?|prospekt|aktion|seite|tel|telefon|fax|www|http|facebook|instagram|darmstadt|offenbach|yazgulu|yazguelue)$/.test(normalized) ||
    /^(nur|je|ab|kg|g|l|ml|cl|stk|stuck|stueck|packung|becher|dose|flasche)$/.test(normalized)
  );
}

function priceFromLine(value: string): { price: number; index: number; raw: string } | null {
  const match = value.match(/(?:^|[^\d])(\d{1,2})\s*[,.]\s*(\d{2})(?=$|[^\d])/);
  if (!match || match.index === undefined) {
    return null;
  }

  const price = Number(`${match[1]}.${match[2]}`);
  if (!Number.isFinite(price) || price < 0.1 || price > 99) {
    return null;
  }

  return {
    price: Number(price.toFixed(2)),
    index: match.index + match[0].search(/\d/),
    raw: `${match[1]},${match[2]}`,
  };
}

function unitFromText(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, ' ');
  const match =
    normalized.match(/\b(?:je\s+)?(\d+(?:[,.]\d+)?\s*(?:kg|g|l|ml|cl))\b/i) ??
    normalized.match(/\b(?:je\s+)?(kg|g|l|ml|cl|stk|stueck|stück|dose|flasche|becher|packung)\b/i);
  if (!match) {
    return undefined;
  }

  return match[1].replace(/\s+/g, '').replace(',', '.').replace(/stück/i, 'Stk');
}

function cleanOfferName(value: string): string {
  return value
    .replace(/\d{1,2}\s*[,.]\s*\d{2}.*/g, '')
    .replace(/\b(?:je|nur|ab)\b/gi, ' ')
    .replace(/\b\d+(?:[,.]\d+)?\s*(?:kg|g|l|ml|cl)\b/gi, ' ')
    .replace(/\b(?:kg|g|l|ml|cl|stk|stueck|stück|dose|flasche|becher|packung)\b$/i, '')
    .replace(/[^\p{L}\p{N}&%+.\- ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameFromWindow(lines: string[], priceLineIndex: number, priceIndex: number): string | null {
  const sameLinePrefix = cleanOfferName(lines[priceLineIndex].slice(0, priceIndex));
  if (sameLinePrefix.length >= 3 && !isIgnoredOcrLine(sameLinePrefix)) {
    return sameLinePrefix;
  }

  const candidates: string[] = [];
  for (let index = priceLineIndex - 1; index >= Math.max(0, priceLineIndex - 6); index -= 1) {
    const line = lines[index];
    if (priceFromLine(line) || isDateRangeLine(line)) {
      break;
    }
    if (isIgnoredOcrLine(line)) {
      continue;
    }
    const cleaned = cleanOfferName(line);
    if (!cleaned || cleaned.length < 3 || unitFromText(cleaned) === cleaned) {
      continue;
    }
    candidates.unshift(cleaned);
  }

  if (candidates.length === 0) {
    return null;
  }

  return candidates.slice(-2).join(' ').trim();
}

function defaultValidity(now: Date): { start: string; end: string } {
  const start = new Date(now);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export function parseYazguluOcrText(
  text: string,
  context: {
    market: LocalMarketConfig;
    sourceUrl: string;
    imageUrl?: string;
    validityStart?: string;
    validityEnd?: string;
    distanceKm?: number;
    now?: Date;
  },
): RawOfferCandidate[] {
  const lines = text
    .split(/\r?\n/)
    .map(cleanOcrLine)
    .filter(Boolean);
  const fallbackValidity = defaultValidity(context.now ?? new Date());
  const validityStart = context.validityStart ?? fallbackValidity.start;
  const validityEnd = context.validityEnd ?? fallbackValidity.end;
  const offers: RawOfferCandidate[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isIgnoredOcrLine(line)) {
      continue;
    }

    const price = priceFromLine(line);
    if (!price) {
      continue;
    }

    const name = nameFromWindow(lines, index, price.index);
    if (!name || isIgnoredOcrLine(name) || name.length < 3) {
      continue;
    }

    const nearbyText = lines
      .slice(Math.max(0, index - 3), index + 1)
      .filter((entry) => !isIgnoredOcrLine(entry))
      .join(' ');
    const unit = unitFromText(nearbyText) ?? 'Stk';
    const key = `${normalizeText(name)}|${price.raw}|${validityStart}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    offers.push({
      id: stableLocalOfferId(context.market.storeId, name, price.price, validityStart),
      name,
      storeId: context.market.storeId,
      storeAddress: context.market.address,
      storeCity: context.market.city,
      storeChain: context.market.storeChain,
      category: toSimpleOfferCategory('Yazgülü Prospekt', name),
      price: price.price,
      currency: 'EUR',
      unit,
      validityStart,
      validityEnd,
      imageUrl: context.imageUrl,
      sourceUrl: context.sourceUrl,
      region: context.market.city,
      postalCode: context.market.postalCode,
      latitude: context.market.latitude,
      longitude: context.market.longitude,
      sourceScope: 'local',
      distanceKm: context.distanceKm,
      tags: ['local', 'yazgulu', normalizeText(context.market.city)],
    });
  }

  return offers;
}

function extractProspectRefs(html: string, baseUrl: string, now: Date): ProspectRef[] {
  const refs = new Map<string, ProspectRef>();
  const anchorMatches = html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);

  for (const match of anchorMatches) {
    const url = resolveUrl(match[1], baseUrl);
    if (!url || !/yazguelue|yazgulu/i.test(url) || !/\d{1,2}[-.]\d{1,2}/.test(url)) {
      continue;
    }

    const label = stripHtml(match[2]) || url;
    const range = parseGermanDateRange(`${label} ${url}`, now);
    refs.set(url, {
      url,
      label,
      validityStart: range?.start,
      validityEnd: range?.end,
    });
  }

  const urlMatches = html.matchAll(/https?:\/\/[^"'\s<>]+\/yazg(?:u|ue)lue[^"'\s<>]+/gi);
  for (const match of urlMatches) {
    const url = resolveUrl(match[0], baseUrl);
    if (!url || refs.has(url)) {
      continue;
    }
    const range = parseGermanDateRange(url, now);
    refs.set(url, {
      url,
      label: url,
      validityStart: range?.start,
      validityEnd: range?.end,
    });
  }

  return [...refs.values()].sort((left, right) => {
    const leftTime = left.validityStart ? new Date(left.validityStart).getTime() : 0;
    const rightTime = right.validityStart ? new Date(right.validityStart).getTime() : 0;
    return rightTime - leftTime;
  });
}

function selectProspectsForNow(
  refs: ProspectRef[],
  now: Date,
  warnings: string[],
  market: LocalMarketConfig,
): ProspectRef[] {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const maxFuture = todayStart + 21 * 24 * 60 * 60 * 1000;
  const activeOrUpcoming = refs.filter((ref) => {
    if (!ref.validityStart || !ref.validityEnd) {
      return false;
    }
    const start = new Date(ref.validityStart).getTime();
    const end = new Date(ref.validityEnd).getTime();
    return end >= todayStart && start <= maxFuture;
  });

  if (activeOrUpcoming.length > 0) {
    return activeOrUpcoming.slice(0, 2);
  }

  const latest = refs[0];
  if (latest?.validityEnd && new Date(latest.validityEnd).getTime() < todayStart) {
    warnings.push(
      `${market.displayName}: kein aktuell gueltiger Prospekt gefunden; letzter Prospekt ist ${latest.label}.`,
    );
  }

  return latest ? [latest] : [];
}

function extractProspectImageUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const imageMatches = html.matchAll(/(?:src|href)=["']([^"']+\.(?:webp|png|jpe?g)(?:\?[^"']*)?)["']/gi);
  for (const match of imageMatches) {
    const url = resolveUrl(match[1], baseUrl);
    if (!url || !/\/wp-content\/uploads\//i.test(url)) {
      continue;
    }
    if (/logo|favicon|cropped|icon/i.test(url)) {
      continue;
    }
    urls.add(url);
  }

  const bareImageMatches = html.matchAll(
    /https?:\\?\/\\?\/[^"'\s<>\\]+?\.(?:webp|png|jpe?g)(?:\?[^"'\s<>\\]*)?/gi,
  );
  for (const match of bareImageMatches) {
    const rawUrl = match[0].replace(/\\\//g, '/');
    const url = resolveUrl(rawUrl, baseUrl);
    if (!url || !/\/wp-content\/uploads\//i.test(url)) {
      continue;
    }
    if (/logo|favicon|cropped|icon/i.test(url)) {
      continue;
    }
    urls.add(url);
  }

  return [...urls].slice(0, 4);
}

async function defaultOcrImage(imageBuffer: Buffer): Promise<string> {
  let ocrBuffer = imageBuffer;
  try {
    const { createCanvas, loadImage } = await loadCanvasModule();
    const image = await loadImage(imageBuffer);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    ocrBuffer = canvas.toBuffer('image/png');
  } catch {
    // Tesseract can still try the original bytes.
  }

  const { createWorker } = await loadTesseractModule();
  const worker = await createWorker('deu+eng');
  try {
    const result = await worker.recognize(ocrBuffer);
    return result.data.text;
  } finally {
    await worker.terminate();
  }
}

function dedupeOffers(offers: RawOfferCandidate[]): RawOfferCandidate[] {
  const byId = new Map<string, RawOfferCandidate>();
  for (const offer of offers) {
    if (offer.id) {
      byId.set(offer.id, offer);
    }
  }
  return [...byId.values()];
}

export class LocalMarketSourceConnector implements SourceConnector {
  public readonly id = 'local-market-offers';
  public readonly displayName = 'Lokale Markt-Websites';
  private lastWarnings: string[] = [];
  private readonly markets: LocalMarketConfig[];
  private readonly geocoder: NominatimGeocoder;
  private readonly fetcher: FetchLike;
  private readonly now: () => Date;
  private readonly ocrImage: OcrImageFn;

  public constructor(options?: {
    markets?: LocalMarketConfig[];
    geocoder?: NominatimGeocoder;
    fetcher?: FetchLike;
    now?: () => Date;
    ocrImage?: OcrImageFn;
  }) {
    this.markets = options?.markets ?? localMarketRegistry;
    this.geocoder = options?.geocoder ?? new NominatimGeocoder();
    this.fetcher = options?.fetcher ?? fetch;
    this.now = options?.now ?? (() => new Date());
    this.ocrImage = options?.ocrImage ?? ((buffer) => defaultOcrImage(buffer));
  }

  public async fetchRawContent(): Promise<RawSourceDocument[]> {
    return [];
  }

  public getLastWarnings(): string[] {
    return this.lastWarnings;
  }

  public async fetchRawOffers(locationFilter: LocationFilter): Promise<RawOfferCandidate[]> {
    const cacheKey = JSON.stringify({
      locationFilter,
      markets: this.markets
        .filter((market) => market.active)
        .map((market) => [market.storeId, market.sourceUrls]),
    });
    const nowMs = Date.now();

    if (
      cacheEntry &&
      cacheEntry.key === cacheKey &&
      nowMs - cacheEntry.createdAt < appConfig.ingestCacheTtlMs
    ) {
      this.lastWarnings = cacheEntry.warnings;
      return cacheEntry.offers;
    }

    const warnings: string[] = [];
    const selection = await selectLocalMarketsForLocation(
      locationFilter,
      this.geocoder,
      this.markets,
    );
    warnings.push(...selection.warnings);

    const offers: RawOfferCandidate[] = [];
    for (const entry of selection.markets) {
      offers.push(...(await this.fetchMarketOffers(entry, warnings)));
    }

    if (selection.markets.length === 0 && locationFilter.mode !== 'none') {
      warnings.push('Lokale Maerkte: kein aktiver Markt im gewaehlten Radius gefunden.');
    }

    const deduped = dedupeOffers(offers);
    cacheEntry = {
      key: cacheKey,
      offers: deduped,
      warnings,
      createdAt: Date.now(),
    };
    this.lastWarnings = warnings;
    return deduped;
  }

  private async fetchMarketOffers(
    entry: LocalMarketWithDistance,
    warnings: string[],
  ): Promise<RawOfferCandidate[]> {
    const { market, distanceKm } = entry;
    const now = this.now();
    const prospectRefs: ProspectRef[] = [];

    for (const sourceUrl of market.sourceUrls) {
      try {
        const html = await this.fetchText(sourceUrl);
        prospectRefs.push(...extractProspectRefs(html, sourceUrl, now));
      } catch (error) {
        warnings.push(
          `${market.displayName}: Quellen-Seite konnte nicht gelesen werden (${
            error instanceof Error ? error.message : 'unbekannter Fehler'
          }).`,
        );
      }
    }

    const selectedProspects = selectProspectsForNow(
      prospectRefs,
      now,
      warnings,
      market,
    );
    if (selectedProspects.length === 0) {
      warnings.push(`${market.displayName}: kein Prospekt-Link gefunden.`);
      return [];
    }

    const offers: RawOfferCandidate[] = [];
    for (const prospect of selectedProspects) {
      try {
        offers.push(...(await this.fetchProspectOffers(market, prospect, distanceKm, warnings)));
      } catch (error) {
        warnings.push(
          `${market.displayName}: Prospekt ${prospect.url} konnte nicht verarbeitet werden (${
            error instanceof Error ? error.message : 'unbekannter Fehler'
          }).`,
        );
      }
    }

    if (offers.length === 0) {
      warnings.push(`${market.displayName}: keine Angebote im Prospekt erkannt.`);
    }

    return offers;
  }

  private async fetchProspectOffers(
    market: LocalMarketConfig,
    prospect: ProspectRef,
    distanceKm: number | undefined,
    warnings: string[],
  ): Promise<RawOfferCandidate[]> {
    const html = await this.fetchText(prospect.url);
    const imageUrls = extractProspectImageUrls(html, prospect.url);
    if (imageUrls.length === 0) {
      warnings.push(`${market.displayName}: Prospekt enthaelt kein lesbares Bild.`);
      return [];
    }

    const offers: RawOfferCandidate[] = [];
    for (const imageUrl of imageUrls) {
      try {
        const imageBuffer = await this.fetchBinary(imageUrl);
        const ocrText = await this.ocrImage(imageBuffer, imageUrl);
        offers.push(
          ...parseYazguluOcrText(ocrText, {
            market,
            sourceUrl: prospect.url,
            imageUrl,
            validityStart: prospect.validityStart,
            validityEnd: prospect.validityEnd,
            distanceKm,
            now: this.now(),
          }),
        );
      } catch (error) {
        warnings.push(
          `${market.displayName}: Prospektbild konnte nicht per OCR gelesen werden (${
            error instanceof Error ? error.message : 'unbekannter Fehler'
          }).`,
        );
      }
    }

    return offers;
  }

  private async fetchText(url: string): Promise<string> {
    await waitForRateLimit();
    const response = await this.fetcher(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain',
        'User-Agent': 'AICheffLocalOffers/1.0',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
  }

  private async fetchBinary(url: string): Promise<Buffer> {
    await waitForRateLimit();
    const response = await this.fetcher(url, {
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*',
        'User-Agent': 'AICheffLocalOffers/1.0',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

export const localMarketConnectorTestApi = {
  parseGermanDateRange,
  parseYazguluOcrText,
  resetCache: () => {
    cacheEntry = null;
    lastRequestAt = 0;
  },
};
