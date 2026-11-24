import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  displayName?: string;
  cachedAt: string;
}

interface NominatimItem {
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
}

type GeocodeCacheFile = Record<string, GeocodeResult>;
type FetchLike = typeof fetch;

const defaultUserAgent = 'AICheffLocalOffers/1.0 (local backend; Nominatim cached)';

function resolveDefaultCacheFile(): string {
  return path.resolve(process.cwd(), 'backend/data/geocode-cache.json');
}

function normalizeCacheKey(kind: 'postalCode' | 'address', value: string): string {
  return `${kind}:${value.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function normalizePostalCode(value: string): string {
  return value.replace(/[^\d]/g, '').slice(0, 5);
}

function toFiniteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class NominatimGeocoder {
  private readonly cacheFile: string;
  private readonly fetcher: FetchLike;
  private readonly userAgent: string;
  private cache: GeocodeCacheFile | null = null;
  private lastRequestAt = 0;

  public constructor(options?: {
    cacheFile?: string;
    fetcher?: FetchLike;
    userAgent?: string;
  }) {
    this.cacheFile = options?.cacheFile ?? resolveDefaultCacheFile();
    this.fetcher = options?.fetcher ?? fetch;
    this.userAgent = options?.userAgent ?? defaultUserAgent;
  }

  public async geocodePostalCode(postalCode: string): Promise<GeocodeResult | null> {
    const normalized = normalizePostalCode(postalCode);
    if (normalized.length < 4) {
      return null;
    }

    return this.geocode('postalCode', `${normalized}, Deutschland`, {
      postalcode: normalized,
      countrycodes: 'de',
    });
  }

  public async geocodeAddress(address: string): Promise<GeocodeResult | null> {
    const normalized = address.trim();
    if (!normalized) {
      return null;
    }

    return this.geocode('address', normalized, {
      q: normalized,
      countrycodes: 'de',
    });
  }

  private async geocode(
    kind: 'postalCode' | 'address',
    cacheValue: string,
    params: Record<string, string>,
  ): Promise<GeocodeResult | null> {
    const key = normalizeCacheKey(kind, cacheValue);
    const cache = await this.loadCache();
    const cached = cache[key];
    if (cached) {
      return cached;
    }

    const query = new URLSearchParams({
      format: 'jsonv2',
      limit: '1',
      ...params,
    });

    await this.waitForRateLimit();

    try {
      const response = await this.fetcher(
        `https://nominatim.openstreetmap.org/search?${query.toString()}`,
        {
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'application/json',
          },
        },
      );

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as unknown;
      const first = Array.isArray(payload) ? (payload[0] as NominatimItem | undefined) : undefined;
      const latitude = toFiniteNumber(first?.lat);
      const longitude = toFiniteNumber(first?.lon);
      if (latitude === null || longitude === null) {
        return null;
      }

      const result: GeocodeResult = {
        latitude,
        longitude,
        displayName:
          typeof first?.display_name === 'string' ? first.display_name : undefined,
        cachedAt: new Date().toISOString(),
      };
      cache[key] = result;
      await this.saveCache(cache);
      return result;
    } catch {
      return null;
    }
  }

  private async waitForRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < 1000) {
      await wait(1000 - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  private async loadCache(): Promise<GeocodeCacheFile> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await fs.readFile(this.cacheFile, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      this.cache = typeof parsed === 'object' && parsed !== null
        ? (parsed as GeocodeCacheFile)
        : {};
    } catch {
      this.cache = {};
    }

    return this.cache;
  }

  private async saveCache(cache: GeocodeCacheFile): Promise<void> {
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    await fs.writeFile(this.cacheFile, JSON.stringify(cache, null, 2), 'utf8');
  }
}

export const geocodingTestApi = {
  normalizePostalCode,
  normalizeCacheKey,
};
