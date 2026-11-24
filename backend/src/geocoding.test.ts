import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NominatimGeocoder } from './geocoding';

describe('NominatimGeocoder', () => {
  it('caches postal code geocoding results on disk', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aichef-geocode-'));
    const cacheFile = path.join(tempDir, 'geocode-cache.json');
    let requestCount = 0;
    const fetcher: typeof fetch = async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify([
          {
            lat: '49.8728',
            lon: '8.6512',
            display_name: '64283 Darmstadt, Deutschland',
          },
        ]),
        { status: 200 },
      );
    };

    try {
      const geocoder = new NominatimGeocoder({ cacheFile, fetcher });
      const first = await geocoder.geocodePostalCode('64283');
      const second = await geocoder.geocodePostalCode('64283');

      expect(first?.latitude).toBeCloseTo(49.8728);
      expect(second?.longitude).toBeCloseTo(8.6512);
      expect(requestCount).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns null on failed Nominatim responses', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aichef-geocode-'));
    const cacheFile = path.join(tempDir, 'geocode-cache.json');
    const fetcher: typeof fetch = async () =>
      new Response('nope', { status: 503 });
    const geocoder = new NominatimGeocoder({ cacheFile, fetcher });

    try {
      await expect(geocoder.geocodePostalCode('64283')).resolves.toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
