import { describe, expect, it } from 'vitest';
import { officialSupermarketTestApi } from './officialSupermarketConnector';
import { classifyOfferBucket } from '../../../utils/offerBucket';

const STORE = {
  storeChain: 'ALDI NORD',
  url: 'https://www.aldi-nord.de/angebote.html',
  parser: 'aldiNord' as const,
};

/** OFFER_GET-apiData als __NEXT_DATA__-Script verpacken (unescaptes JSON). */
function nextDataHtml(apiData: unknown): string {
  const nextData = { props: { pageProps: { apiData } } };
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData,
  )}</script></body></html>`;
}

function offerGet(algoliaDataMap: Record<string, unknown>, areas: unknown[] = []): unknown {
  return [['OFFER_GET', { res: { algoliaDataMap, data: areas } }]];
}

describe('ALDI NORD — strukturierter Website-Connector', () => {
  it('liest Red Bull aus __NEXT_DATA__/apiData (Marke+Name, Preis, UVP, Einheit, Pfand, Gültigkeit, Bild)', () => {
    const html = nextDataHtml(
      offerGet({
        '2002': {
          objectID: '2002',
          brandName: 'Red Bull',
          name: 'Energy Drink',
          salesUnit: '12x0,25-L-Dosen',
          mainCategoryID: 'Getränke',
          currentPrice: {
            priceValue: 9.99,
            strikePrice: { strikePriceValue: 14.9 },
            basePrice: [{ basePriceValue: 3.33, basePriceScale: 'l' }],
            depositValue: 3,
          },
          promotionPrices: [
            {
              priceValue: 9.99,
              validFromLocalDate: '2026-06-25',
              validUntilLocalDate: '2026-06-27',
            },
          ],
          assets: [
            { type: 'primary', url: 'https://s7g10.scene7.com/is/image/aldinord/red-bull' },
          ],
        },
      }),
    );

    const offers = officialSupermarketTestApi.parseAldiNordApiData(html, STORE);
    expect(offers).toHaveLength(1);
    const offer = offers[0];
    expect(offer.name).toBe('Red Bull Energy Drink');
    expect(offer.brand).toBe('Red Bull');
    expect(offer.price).toBe(9.99);
    expect(offer.originalPrice).toBe(14.9);
    expect(offer.unit).toBe('12x0,25-L-Dosen');
    expect(offer.basePrice).toBe(3.33);
    expect(offer.baseUnit).toBe('l');
    expect(offer.validityStart).toBe('2026-06-25T00:00:00.000Z');
    expect(offer.validityEnd).toBe('2026-06-27T23:59:59.999Z');
    expect(offer.imageUrl).toBe('https://s7g10.scene7.com/is/image/aldinord/red-bull');
    // Pfand wird NICHT in den Preis gerechnet, sondern als Roh-Kontext geführt.
    expect(offer.price).toBe(9.99);
    expect(offer.sourceContextRaw).toContain('Pfand: 3.00 EUR');
    expect(offer.tags).toContain('aldi-nord-structured');
  });

  it('liest apiData auch aus dem escapten JSON-String (self.__next_f-Chunk)', () => {
    const apiData = JSON.stringify(
      offerGet({
        '1001246': {
          objectID: '1001246',
          brandName: 'LANDFREUDE',
          name: 'Gabelspaghetti',
          salesUnit: '500-g-Beutel',
          mainCategoryID: 'Angebote',
          currentPrice: {
            priceValue: 1.19,
            basePrice: [{ basePriceValue: 2.38, basePriceScale: 'kg' }],
          },
          promotionPrices: [
            { priceValue: 1.19, validFromLocalDate: '2026-06-22', validUntilLocalDate: '2026-06-27' },
          ],
        },
      }),
    )
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
    const html = `<script>self.__next_f.push([1,"apiData":"${apiData}"])</script>`;

    const offers = officialSupermarketTestApi.parseAldiNordApiData(html, STORE);
    expect(offers).toHaveLength(1);
    expect(offers[0].name).toBe('LANDFREUDE Gabelspaghetti');
    expect(offers[0].price).toBe(1.19);
  });

  it('ordnet Produkte ihren Angebotsbereichen zu (Frische-Aktion: Obst & Gemüse mit Mo/Do-Bereichen)', () => {
    const html = nextDataHtml(
      offerGet(
        {
          '3001': { objectID: '3001', name: 'Bananen', currentPrice: { priceValue: 1.29 } },
          '3002': { objectID: '3002', name: 'Erdbeeren', currentPrice: { priceValue: 2.49 } },
        },
        [
          {
            name: 'Frische-Aktion: Obst & Gemüse',
            validFromLocalDate: '2026-06-22',
            validUntilLocalDate: '2026-06-27',
            productIds: ['3001'],
          },
          {
            name: 'Aktion Do. 25.6.',
            validFromLocalDate: '2026-06-25',
            validUntilLocalDate: '2026-06-27',
            productIds: ['3002'],
          },
        ],
      ),
    );

    const offers = officialSupermarketTestApi.parseAldiNordApiData(html, STORE);
    const banane = offers.find((o) => o.name === 'Bananen');
    const erdbeere = offers.find((o) => o.name === 'Erdbeeren');
    expect(banane?.sourceCategoryRaw).toBe('Frische-Aktion: Obst & Gemüse');
    expect(banane?.validityStart).toBe('2026-06-22T00:00:00.000Z');
    expect(erdbeere?.sourceCategoryRaw).toBe('Aktion Do. 25.6.');
    expect(erdbeere?.validityStart).toBe('2026-06-25T00:00:00.000Z');
  });

  it('markiert Future-Angebote (validFromLocalDate > today) als upcoming, nicht current', () => {
    const now = new Date('2026-06-23T12:00:00.000Z');
    const html = nextDataHtml(
      offerGet({
        '5001': {
          objectID: '5001',
          name: 'Grillkäse',
          currentPrice: { priceValue: 1.99 },
          promotionPrices: [
            { priceValue: 1.99, validFromLocalDate: '2026-06-25', validUntilLocalDate: '2026-06-27' },
          ],
        },
        '5002': {
          objectID: '5002',
          name: 'Aktuelle Milch',
          currentPrice: { priceValue: 0.99 },
          promotionPrices: [
            { priceValue: 0.99, validFromLocalDate: '2026-06-22', validUntilLocalDate: '2026-06-27' },
          ],
        },
      }),
    );

    const { offers, diagnostics } = officialSupermarketTestApi.parseAldiNordOffers(html, STORE, { now });
    const future = offers.find((o) => o.name === 'Grillkäse');
    const current = offers.find((o) => o.name === 'Aktuelle Milch');
    expect(classifyOfferBucket(future!, now)).toBe('upcoming');
    expect(classifyOfferBucket(current!, now)).toBe('current');
    expect(diagnostics.futureProducts).toBe(1);
    expect(diagnostics.currentProducts).toBe(1);
  });

  it('liefert die strukturierte Zählkette als Diagnose (Preis/Datum/Bild + Beispiele)', () => {
    const html = nextDataHtml(
      offerGet({
        ok: {
          objectID: 'ok',
          name: 'Vollständig',
          currentPrice: { priceValue: 1.0, validFrom: 1781000000, validUntil: 1781600000 },
          assets: [{ type: 'primary', url: 'https://img.aldi/ok.jpg' }],
        },
        noPrice: { objectID: 'noPrice', name: 'Ohne Preis' },
      }),
    );
    const { offers, diagnostics } = officialSupermarketTestApi.parseAldiNordOffers(html, STORE);
    expect(diagnostics.apiDataFound).toBe(true);
    expect(diagnostics.structuredProductsFound).toBe(2);
    expect(diagnostics.productsWithPrice).toBe(1);
    expect(diagnostics.productsWithImage).toBe(1);
    expect(diagnostics.importedDistinct).toBe(1);
    expect(diagnostics.missingPriceExamples).toContain('Ohne Preis');
    expect(offers).toHaveLength(1);
  });

  it('fällt sauber auf eine leere Liste + apiDataFound=false zurück, wenn apiData fehlt', () => {
    const { offers, diagnostics } = officialSupermarketTestApi.parseAldiNordOffers(
      '<html><body>kein Angebots-JSON</body></html>',
      STORE,
    );
    expect(offers).toEqual([]);
    expect(diagnostics.apiDataFound).toBe(false);
    expect(diagnostics.blocked).toBe(false);
    expect(diagnostics.importedDistinct).toBe(0);
  });
});
