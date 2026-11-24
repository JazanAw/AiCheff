// RN-freie Auswertung von `GET /api/offers/article/:articleId`.
//
// Bewusst ohne react-native-Import (wie backendUrl.ts): so laesst sich das
// Parsen in der Node-Testumgebung pruefen. `offersApi.ts` haengt nur noch den
// Netzabruf davor.

/** Ein Laden, der diesen Artikel gerade im Angebot hat. */
export interface ArticleOfferLocation {
  offerId: string;
  storeChain: string;
  storeCity?: string;
  storeAddress?: string;
  distanceKm?: number;
  price: number;
  currency: string;
  validityStart: string;
  validityEnd: string;
}

export interface ArticleOffersResult {
  articleId: string;
  isOnOffer: boolean;
  /** Nach Preis aufsteigend — der Backend-Endpunkt sortiert bereits. */
  locations: ArticleOfferLocation[];
  /** Trifft der Artikel erst naechste Woche wieder zu, ist das hier > 0. */
  nextWeekCount: number;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Wertet die Antwort defensiv aus.
 *
 * `isOnOffer` gilt nur, wenn der Server es meldet UND mindestens ein Standort
 * mit Preis uebrig bleibt: ein Angebot ohne Preis ist fuer die Favoritenliste
 * wertlos, und ein „im Angebot"-Hinweis ohne Laden waere eine leere Zusage.
 */
export function parseArticleOffersPayload(
  payload: unknown,
  fallbackArticleId: string,
): ArticleOffersResult {
  const root = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const rawLocations = Array.isArray(root.locations) ? root.locations : [];

  const locations: ArticleOfferLocation[] = [];
  for (const entry of rawLocations) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const price = toNumber(row.price);
    const storeChain = toText(row.storeChain);
    // Ohne Preis oder Laden ist die Zeile nicht anzeigbar — nichts raten.
    if (price === undefined || storeChain === undefined) continue;
    locations.push({
      offerId: String(row.offerId ?? ''),
      storeChain,
      storeCity: toText(row.storeCity),
      storeAddress: toText(row.storeAddress),
      distanceKm: toNumber(row.distanceKm),
      price,
      currency: toText(row.currency) ?? 'EUR',
      validityStart: String(row.validityStart ?? ''),
      validityEnd: String(row.validityEnd ?? ''),
    });
  }

  return {
    articleId: toText(root.articleId) ?? fallbackArticleId,
    isOnOffer: root.isOnOffer === true && locations.length > 0,
    locations,
    nextWeekCount: Array.isArray(root.nextWeekOffers) ? root.nextWeekOffers.length : 0,
  };
}
