import { describe, expect, it } from 'vitest';
import type { LocationFilter } from '../../src/types/models';
import { NominatimGeocoder } from './geocoding';
import {
  LocalMarketSourceConnector,
  localMarketConnectorTestApi,
  parseYazguluOcrText,
} from './localMarketConnector';
import type { LocalMarketConfig } from './localMarkets';

const market: LocalMarketConfig = {
  storeId: 'yazgulu-test',
  displayName: 'Yazgülü Test',
  storeChain: 'Yazgülü Test',
  address: 'Pallaswiesenstraße 80, 64293 Darmstadt',
  postalCode: '64293',
  city: 'Darmstadt',
  latitude: 49.8821857,
  longitude: 8.6422513,
  geocodeStatus: 'fixed',
  radiusKm: 40,
  sourceUrls: ['https://yazgulu.de/yazguelue-supermarkt-darmstadt/'],
  scraperType: 'yazgulu-wordpress-prospect',
  active: true,
};

const locationFilter: LocationFilter = {
  mode: 'gps',
  postalCode: '',
  latitude: 49.882,
  longitude: 8.642,
  radiusKm: 5,
};

describe('parseYazguluOcrText', () => {
  it('extracts local offers from OCR text', () => {
    const offers = parseYazguluOcrText(
      `
      Yazgülü Darmstadt & Offenbach 04.05. - 09.05.2026
      Tomaten
      je kg
      1,99
      Ayran 250 ml
      0,59
      Hähnchenbrust
      je kg
      6,99
      `,
      {
        market,
        sourceUrl: 'https://yazgulu.de/prospekt',
        imageUrl: 'https://yazgulu.de/prospekt.webp',
        validityStart: '2026-05-04T00:00:00.000Z',
        validityEnd: '2026-05-09T23:59:59.999Z',
        distanceKm: 0.2,
      },
    );

    expect(offers).toHaveLength(3);
    expect(offers[0]).toMatchObject({
      name: 'Tomaten',
      price: 1.99,
      unit: 'kg',
      storeId: 'yazgulu-test',
      sourceScope: 'local',
      distanceKm: 0.2,
    });
    expect(offers[1].unit).toBe('250ml');
  });
});

describe('LocalMarketSourceConnector', () => {
  it('discovers a Yazgülü prospect page and returns scoped local offers', async () => {
    localMarketConnectorTestApi.resetCache();
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/yazguelue-supermarkt-darmstadt/')) {
        return new Response(
          '<a href="https://yazgulu.de/yazguelue-darmstadt-offenbach-04-05-09-05-2026/">Prospekt</a>',
          { status: 200 },
        );
      }
      if (url.includes('04-05-09-05-2026')) {
        return new Response(
          '<img src="https://yazgulu.de/wp-content/uploads/2026/05/prospekt.webp" />',
          { status: 200 },
        );
      }
      if (url.endsWith('/prospekt.webp')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      return new Response('missing', { status: 404 });
    };
    const geocoder = new NominatimGeocoder({ fetcher });
    const connector = new LocalMarketSourceConnector({
      markets: [market],
      fetcher,
      geocoder,
      now: () => new Date('2026-05-05T12:00:00.000Z'),
      ocrImage: async () => `
        Tomaten
        je kg
        1,99
        Ayran 250 ml
        0,59
      `,
    });

    const offers = await connector.fetchRawOffers(locationFilter);

    expect(offers).toHaveLength(2);
    expect(offers[0].storeChain).toBe('Yazgülü Test');
    expect(offers[0].validityStart).toBe('2026-05-04T00:00:00.000Z');
    expect(offers[0].sourceScope).toBe('local');
    expect(offers[0].distanceKm).toBeLessThan(1);
    expect(connector.getLastWarnings()).toEqual([]);
  });
});
