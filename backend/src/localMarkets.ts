import type { LocationFilter } from '../../src/types/models';
import { getDistanceKm } from '../../src/utils/offers';
import type { NominatimGeocoder } from './geocoding';

export type LocalMarketScraperType = 'yazgulu-wordpress-prospect';

export interface LocalMarketConfig {
  storeId: string;
  displayName: string;
  storeChain: string;
  address: string;
  postalCode: string;
  city: string;
  latitude?: number;
  longitude?: number;
  geocodeStatus: 'fixed' | 'geocode-required';
  radiusKm: number;
  sourceUrls: string[];
  scraperType: LocalMarketScraperType;
  active: boolean;
}

export interface LocalMarketWithDistance {
  market: LocalMarketConfig;
  distanceKm?: number;
}

export interface LocalMarketSelection {
  markets: LocalMarketWithDistance[];
  warnings: string[];
}

export const localMarketRegistry: LocalMarketConfig[] = [
  {
    storeId: 'yazgulu-darmstadt',
    displayName: 'Yazgülü Darmstadt',
    storeChain: 'Yazgülü Darmstadt',
    address: 'Pallaswiesenstraße 80, 64293 Darmstadt',
    postalCode: '64293',
    city: 'Darmstadt',
    latitude: 49.8821857,
    longitude: 8.6422513,
    geocodeStatus: 'fixed',
    radiusKm: 40,
    sourceUrls: [
      'https://yazgulu.de/yazguelue-supermarkt-darmstadt/',
      'https://yazgulu.de/angebote/',
    ],
    scraperType: 'yazgulu-wordpress-prospect',
    active: true,
  },
  {
    storeId: 'yazgulu-offenbach',
    displayName: 'Yazgülü Offenbach',
    storeChain: 'Yazgülü Offenbach',
    address: 'Jacques-Offenbach-Straße 6, 63069 Offenbach am Main',
    postalCode: '63069',
    city: 'Offenbach am Main',
    latitude: 50.0864507,
    longitude: 8.7601857,
    geocodeStatus: 'fixed',
    radiusKm: 40,
    sourceUrls: [
      'https://yazgulu.de/yazguelue-supermarkt-offenbach/',
      'https://yazgulu.de/angebote/',
    ],
    scraperType: 'yazgulu-wordpress-prospect',
    active: true,
  },
];

function normalizePostalCode(value: string): string {
  return value.replace(/[^\d]/g, '').slice(0, 5);
}

function hasCoordinates(
  market: LocalMarketConfig,
): market is LocalMarketConfig & { latitude: number; longitude: number } {
  return Number.isFinite(market.latitude) && Number.isFinite(market.longitude);
}

function firstTwoPostalDigits(value: string): string {
  return normalizePostalCode(value).slice(0, 2);
}

async function resolveLocationCenter(
  locationFilter: LocationFilter,
  geocoder: NominatimGeocoder,
  warnings: string[],
): Promise<{ latitude: number; longitude: number } | null> {
  if (
    locationFilter.mode === 'gps' &&
    locationFilter.latitude !== null &&
    locationFilter.longitude !== null
  ) {
    return {
      latitude: locationFilter.latitude,
      longitude: locationFilter.longitude,
    };
  }

  if (locationFilter.mode !== 'postalCode' || !locationFilter.postalCode.trim()) {
    return null;
  }

  const result = await geocoder.geocodePostalCode(locationFilter.postalCode);
  if (!result) {
    warnings.push(
      `Lokale Maerkte: PLZ ${normalizePostalCode(locationFilter.postalCode)} konnte nicht geocodiert werden; nutze PLZ-Fallback.`,
    );
    return null;
  }

  return {
    latitude: result.latitude,
    longitude: result.longitude,
  };
}

export async function selectLocalMarketsForLocation(
  locationFilter: LocationFilter,
  geocoder: NominatimGeocoder,
  markets: LocalMarketConfig[] = localMarketRegistry,
): Promise<LocalMarketSelection> {
  const warnings: string[] = [];
  const activeMarkets = markets.filter((market) => market.active);

  if (locationFilter.mode === 'none') {
    return {
      markets: activeMarkets.map((market) => ({ market })),
      warnings,
    };
  }

  const center = await resolveLocationCenter(locationFilter, geocoder, warnings);
  const selected: LocalMarketWithDistance[] = [];

  for (const market of activeMarkets) {
    if (!hasCoordinates(market)) {
      const geocoded = await geocoder.geocodeAddress(market.address);
      if (!geocoded) {
        warnings.push(`${market.displayName}: Adresse konnte nicht geocodiert werden.`);
        continue;
      }
      market.latitude = geocoded.latitude;
      market.longitude = geocoded.longitude;
      market.geocodeStatus = 'fixed';
    }

    if (!center) {
      const requestedPrefix = firstTwoPostalDigits(locationFilter.postalCode);
      if (requestedPrefix && firstTwoPostalDigits(market.postalCode) === requestedPrefix) {
        selected.push({ market });
      }
      continue;
    }

    if (!hasCoordinates(market)) {
      warnings.push(`${market.displayName}: keine Koordinaten verfuegbar.`);
      continue;
    }

    const distanceKm = getDistanceKm(
      center.latitude,
      center.longitude,
      market.latitude,
      market.longitude,
    );
    const maxRadius = Math.min(locationFilter.radiusKm, market.radiusKm);
    if (distanceKm <= maxRadius) {
      selected.push({
        market,
        distanceKm: Number(distanceKm.toFixed(1)),
      });
    }
  }

  return {
    markets: selected,
    warnings,
  };
}

export const localMarketsTestApi = {
  normalizePostalCode,
  selectLocalMarketsForLocation,
};
