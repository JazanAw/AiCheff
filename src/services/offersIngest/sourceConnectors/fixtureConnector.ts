import { appConfig } from '../../../config/env';
import { LocationFilter } from '../../../types/models';
import { demoOfferFixtures } from '../fixtures/demoOfferSource';
import { RawSourceDocument, SourceConnector } from '../types';

interface CacheEntry {
  key: string;
  documents: RawSourceDocument[];
  createdAt: number;
}

let cacheEntry: CacheEntry | null = null;
let lastFetchAt = 0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createLocationKey(locationFilter: LocationFilter): string {
  return JSON.stringify(locationFilter);
}

function shouldIncludeFixture(locationFilter: LocationFilter, postalCode: string): boolean {
  if (locationFilter.mode === 'none') {
    return true;
  }
  if (locationFilter.mode === 'postalCode' && locationFilter.postalCode) {
    return postalCode.startsWith(locationFilter.postalCode.slice(0, 2));
  }
  return true;
}

export class FixtureSourceConnector implements SourceConnector {
  public readonly id = 'fixture-offers';
  public readonly displayName = 'Fixture Offers Connector';

  public async fetchRawContent(
    locationFilter: LocationFilter,
  ): Promise<RawSourceDocument[]> {
    const locationKey = createLocationKey(locationFilter);
    const now = Date.now();

    if (
      cacheEntry &&
      cacheEntry.key === locationKey &&
      now - cacheEntry.createdAt < appConfig.ingestCacheTtlMs
    ) {
      return cacheEntry.documents;
    }

    const sinceLastFetch = now - lastFetchAt;
    if (sinceLastFetch < appConfig.ingestRateLimitMs) {
      await wait(appConfig.ingestRateLimitMs - sinceLastFetch);
    }

    const documents: RawSourceDocument[] = demoOfferFixtures
      .filter((fixture) => shouldIncludeFixture(locationFilter, fixture.postalCode))
      .map((fixture) => ({
        connectorId: this.id,
        sourceUrl: fixture.sourceUrl,
        sourceLabel: fixture.sourceLabel,
        storeChain: fixture.storeChain,
        region: fixture.region,
        postalCode: fixture.postalCode,
        latitude: fixture.latitude,
        longitude: fixture.longitude,
        contentType: 'text',
        content: fixture.content,
        fetchedAt: new Date().toISOString(),
      }));

    cacheEntry = {
      key: locationKey,
      documents,
      createdAt: Date.now(),
    };
    lastFetchAt = Date.now();

    return documents;
  }
}
