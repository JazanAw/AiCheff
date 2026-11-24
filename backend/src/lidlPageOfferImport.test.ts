import { describe, expect, it } from 'vitest';
import type { OfficialStoreConfig } from '../../src/services/offersIngest/sourceConnectors/officialSupermarketConnector';
import type { RawOfferCandidate } from '../../src/services/offersIngest/types';
import { runLidlPageImageImport } from './lidlPageOfferImport';

const lidlStore: OfficialStoreConfig = {
  storeChain: 'Lidl',
  url: 'https://www.lidl.de/c/online-prospekte/s10005610',
  parser: 'lidl',
};

const structuredOffer: RawOfferCandidate = {
  name: 'Rotwein Cuvee',
  storeChain: 'Lidl',
  price: 3.99,
  imageUrl: 'https://cdn.lidl.de/wein.jpg',
  tags: ['lidl-prospekt'],
};

const ocrOffer: RawOfferCandidate = {
  name: 'Erdbeeren 500g',
  storeChain: 'Lidl',
  price: 2.49,
  imageUrl: 'https://leaflets.schwarz/page-12.jpg',
  tags: ['lidl-prospekt-ocr', 'ocr'],
};

const visionOffer: RawOfferCandidate = {
  name: 'Gouda Scheiben',
  storeChain: 'Lidl',
  price: 1.99,
  imageUrl: 'https://leaflets.schwarz/page-13.jpg',
  tags: ['lidl-vision', 'vision'],
};

describe('runLidlPageImageImport', () => {
  it('keeps only OCR-/Vision-derived candidates, discards the structured lidl-prospekt offers', async () => {
    const result = await runLidlPageImageImport({
      fetchStoreHtml: async () => '<html></html>',
      fetchLidlLeafletOffersImpl: async () => [structuredOffer, ocrOffer, visionOffer],
      imageSearch: { searchConfig: null },
    });

    expect(result.offers.map((o) => o.name).sort()).toEqual(['Erdbeeren 500g', 'Gouda Scheiben']);
    expect(result.offers.every((o) => !(o.tags ?? []).includes('lidl-prospekt') || (o.tags ?? []).includes('lidl-prospekt-ocr'))).toBe(
      true,
    );
    expect(result.offers.some((o) => o.name === 'Rotwein Cuvee')).toBe(false);
  });

  it('returns an honest empty result + warning when no Lidl store is configured', async () => {
    const result = await runLidlPageImageImport({
      selectOfficialStoresImpl: () => [],
      fetchStoreHtml: async () => '<html></html>',
      fetchLidlLeafletOffersImpl: async () => [],
      imageSearch: { searchConfig: null },
    });
    expect(result.offers).toEqual([]);
    expect(result.warnings).toEqual(['Lidl-Store-Konfiguration nicht gefunden.']);
  });

  it('passes ocrMode/visionMode/imageLimit through to fetchLidlLeafletOffers', async () => {
    let capturedModes: unknown;
    await runLidlPageImageImport({
      ocrMode: 'live',
      visionMode: 'diagnostic',
      imageLimit: 10,
      fetchStoreHtml: async () => '<html></html>',
      fetchLidlLeafletOffersImpl: async (_html, _store, _warnings, _diagnostics, modes) => {
        capturedModes = modes;
        return [];
      },
      imageSearch: { searchConfig: null },
    });
    expect(capturedModes).toEqual({ ocrMode: 'live', visionMode: 'diagnostic', imageLimit: 10 });
  });

  it('passes the fetched Lidl store config into fetchStoreHtml', async () => {
    let capturedStore: OfficialStoreConfig | undefined;
    await runLidlPageImageImport({
      fetchStoreHtml: async (store) => {
        capturedStore = store;
        return '<html></html>';
      },
      fetchLidlLeafletOffersImpl: async () => [],
      imageSearch: { searchConfig: null },
    });
    expect(capturedStore?.storeChain).toBe(lidlStore.storeChain);
  });

  it('resolves images only for the kept page-image candidates', async () => {
    let seenCandidates: RawOfferCandidate[] = [];
    const result = await runLidlPageImageImport({
      fetchStoreHtml: async () => '<html></html>',
      fetchLidlLeafletOffersImpl: async () => [structuredOffer, ocrOffer],
      imageSearch: { searchConfig: null, probeImpl: undefined },
    });
    seenCandidates = result.offers;
    expect(seenCandidates).toHaveLength(1);
    expect(result.imageStats.keptFallbackPageImage).toBe(1);
  });
});
