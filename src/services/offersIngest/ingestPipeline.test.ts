import { describe, expect, it } from 'vitest';
import { runOffersIngestPipeline } from './ingestPipeline';
import { FixtureSourceConnector } from './sourceConnectors/fixtureConnector';
import type { SourceConnector } from './types';

const LOCATION = {
  mode: 'none' as const,
  postalCode: '',
  latitude: null,
  longitude: null,
  radiusKm: 40,
};

describe('runOffersIngestPipeline — Per-Store-Fortschritt', () => {
  it('reicht den Per-Store-Fortschritt als Statusmeldung durch (kein Hänger bei "Quellen werden geladen...")', async () => {
    const messages: string[] = [];
    const fakeConnector: SourceConnector = {
      id: 'fake',
      displayName: 'Fake',
      fetchRawContent: async () => [],
      fetchRawOffers: async (_location, _ollama, runtime) => {
        runtime?.onStoreProgress?.({
          storeChain: 'Lidl',
          parser: 'lidl',
          index: 6,
          total: 11,
          phase: 'start',
        });
        runtime?.onStoreProgress?.({
          storeChain: 'Lidl',
          parser: 'lidl',
          index: 6,
          total: 11,
          phase: 'success',
          offerCount: 3,
        });
        return [];
      },
    };

    await runOffersIngestPipeline(
      { locationFilter: LOCATION, tryOllama: false, onProgress: (m) => messages.push(m) },
      [fakeConnector],
    );

    expect(messages).toContain('Lidl 6/11 wird geladen...');
    expect(messages).toContain('Lidl 6/11 geladen (3).');
  });
});

describe('runOffersIngestPipeline', () => {
  it('laedt den vollstaendigen Fixture Katalog ueber mehrere Maerkte', async () => {
    const result = await runOffersIngestPipeline({
      locationFilter: {
        mode: 'none',
        postalCode: '',
        latitude: null,
        longitude: null,
        radiusKm: 40,
      },
      tryOllama: false,
    }, [new FixtureSourceConnector()]);

    expect(result.offers.length).toBe(240);
    const stores = new Set(result.offers.map((offer) => offer.storeChain));
    expect(stores.size).toBe(8);
  });
});
