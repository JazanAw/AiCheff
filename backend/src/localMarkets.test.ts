import { describe, expect, it } from 'vitest';
import type { LocationFilter } from '../../src/types/models';
import type { NominatimGeocoder } from './geocoding';
import { selectLocalMarketsForLocation, type LocalMarketConfig } from './localMarkets';

const markets: LocalMarketConfig[] = [
  {
    storeId: 'near-market',
    displayName: 'Near Market',
    storeChain: 'Near Market',
    address: 'Near Street 1',
    postalCode: '64293',
    city: 'Darmstadt',
    latitude: 49.8821857,
    longitude: 8.6422513,
    geocodeStatus: 'fixed',
    radiusKm: 10,
    sourceUrls: ['https://example.org/near'],
    scraperType: 'yazgulu-wordpress-prospect',
    active: true,
  },
  {
    storeId: 'far-market',
    displayName: 'Far Market',
    storeChain: 'Far Market',
    address: 'Far Street 1',
    postalCode: '10115',
    city: 'Berlin',
    latitude: 52.532,
    longitude: 13.384,
    geocodeStatus: 'fixed',
    radiusKm: 10,
    sourceUrls: ['https://example.org/far'],
    scraperType: 'yazgulu-wordpress-prospect',
    active: true,
  },
];

function fakeGeocoder(latitude: number, longitude: number): NominatimGeocoder {
  return {
    geocodePostalCode: async () => ({
      latitude,
      longitude,
      cachedAt: new Date().toISOString(),
    }),
    geocodeAddress: async () => null,
  } as NominatimGeocoder;
}

describe('selectLocalMarketsForLocation', () => {
  it('filters local markets by gps radius', async () => {
    const locationFilter: LocationFilter = {
      mode: 'gps',
      postalCode: '',
      latitude: 49.882,
      longitude: 8.642,
      radiusKm: 5,
    };

    const result = await selectLocalMarketsForLocation(
      locationFilter,
      fakeGeocoder(49.882, 8.642),
      markets,
    );

    expect(result.markets.map((entry) => entry.market.storeId)).toEqual(['near-market']);
    expect(result.markets[0].distanceKm).toBeLessThan(1);
  });

  it('uses geocoded postal codes for radius checks', async () => {
    const locationFilter: LocationFilter = {
      mode: 'postalCode',
      postalCode: '64283',
      latitude: null,
      longitude: null,
      radiusKm: 8,
    };

    const result = await selectLocalMarketsForLocation(
      locationFilter,
      fakeGeocoder(49.8728, 8.6512),
      markets,
    );

    expect(result.markets.map((entry) => entry.market.storeId)).toEqual(['near-market']);
  });

  it('falls back to postal prefix when geocoding fails', async () => {
    const locationFilter: LocationFilter = {
      mode: 'postalCode',
      postalCode: '64283',
      latitude: null,
      longitude: null,
      radiusKm: 8,
    };
    const geocoder = {
      geocodePostalCode: async () => null,
      geocodeAddress: async () => null,
    } as NominatimGeocoder;

    const result = await selectLocalMarketsForLocation(locationFilter, geocoder, markets);

    expect(result.markets.map((entry) => entry.market.storeId)).toEqual(['near-market']);
    expect(result.warnings[0]).toContain('PLZ 64283');
  });
});
