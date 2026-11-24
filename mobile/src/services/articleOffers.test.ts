import { describe, expect, it } from 'vitest';
import { parseArticleOffersPayload } from './articleOffers';

const ARTICLE = 'article_v3_0123456789abcdef';

/** Antwortform von GET /api/offers/article/:articleId, gekuerzt. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    articleId: ARTICLE,
    isOnOffer: true,
    nextWeekOffers: [],
    locations: [
      {
        offerId: 'lidl-woche-35',
        storeChain: 'Lidl',
        storeCity: 'Hannover',
        storeAddress: 'Bardowicker Str. 1',
        distanceKm: 1.2,
        price: 1.29,
        currency: 'EUR',
        validityStart: '2026-08-23T00:00:00.000Z',
        validityEnd: '2026-08-29T23:59:59.000Z',
      },
    ],
    ...overrides,
  };
}

describe('parseArticleOffersPayload', () => {
  it('uebernimmt Laden, Preis und Gueltigkeit eines Angebots', () => {
    const result = parseArticleOffersPayload(payload(), ARTICLE);

    expect(result.isOnOffer).toBe(true);
    expect(result.articleId).toBe(ARTICLE);
    expect(result.locations).toHaveLength(1);
    expect(result.locations[0]).toMatchObject({
      storeChain: 'Lidl',
      storeCity: 'Hannover',
      price: 1.29,
      currency: 'EUR',
      distanceKm: 1.2,
      validityEnd: '2026-08-29T23:59:59.000Z',
    });
  });

  // Ein Angebot ohne Preis ist fuer die Favoritenliste wertlos — es darf weder
  // angezeigt noch als „im Angebot" gezaehlt werden.
  it('verwirft Standorte ohne Preis oder ohne Laden', () => {
    const result = parseArticleOffersPayload(
      payload({
        locations: [
          { offerId: 'a', storeChain: 'Lidl' },
          { offerId: 'b', price: 2.49 },
          { offerId: 'c', storeChain: 'REWE', price: 2.49 },
        ],
      }),
      ARTICLE,
    );

    expect(result.locations).toHaveLength(1);
    expect(result.locations[0].storeChain).toBe('REWE');
  });

  // „Im Angebot" ohne einen einzigen brauchbaren Laden waere eine leere Zusage.
  it('meldet nicht im Angebot, wenn kein Standort uebrig bleibt', () => {
    const result = parseArticleOffersPayload(
      payload({ isOnOffer: true, locations: [{ offerId: 'a' }] }),
      ARTICLE,
    );
    expect(result.isOnOffer).toBe(false);
    expect(result.locations).toEqual([]);
  });

  it('folgt dem Server, wenn er nicht im Angebot meldet', () => {
    const result = parseArticleOffersPayload(payload({ isOnOffer: false }), ARTICLE);
    expect(result.isOnOffer).toBe(false);
  });

  it('zaehlt die Angebote der naechsten Woche', () => {
    const result = parseArticleOffersPayload(
      payload({ isOnOffer: false, locations: [], nextWeekOffers: [{ id: 'x' }, { id: 'y' }] }),
      ARTICLE,
    );
    expect(result.nextWeekCount).toBe(2);
    expect(result.isOnOffer).toBe(false);
  });

  it('faellt ohne articleId in der Antwort auf den angefragten zurueck', () => {
    const result = parseArticleOffersPayload(payload({ articleId: undefined }), ARTICLE);
    expect(result.articleId).toBe(ARTICLE);
  });

  it('liefert fuer eine kaputte Antwort ein leeres Ergebnis statt zu werfen', () => {
    for (const broken of [null, undefined, 'nope', 42, {}, { locations: 'kaputt' }]) {
      const result = parseArticleOffersPayload(broken, ARTICLE);
      expect(result.isOnOffer).toBe(false);
      expect(result.locations).toEqual([]);
      expect(result.nextWeekCount).toBe(0);
      expect(result.articleId).toBe(ARTICLE);
    }
  });

  it('setzt EUR als Waehrung, wenn die Antwort keine nennt', () => {
    const result = parseArticleOffersPayload(
      payload({ locations: [{ offerId: 'a', storeChain: 'Lidl', price: 1 }] }),
      ARTICLE,
    );
    expect(result.locations[0].currency).toBe('EUR');
  });
});
