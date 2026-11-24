import { describe, expect, it } from 'vitest';
import { Offer } from '../../src/types/models';
import { enrichOffersWithOllama } from './offersEnrichment';

function createOffer(overrides: Partial<Offer>): Offer {
  return {
    id: 'offer_test',
    name: 'Bio Haferdrink Natur',
    normalizedName: 'bio haferdrink natur',
    storeChain: 'Aldi',
    category: 'Milchalternativen',
    price: 1.29,
    currency: 'EUR',
    unit: '1l',
    validityStart: '2026-02-02T00:00:00.000Z',
    validityEnd: '2026-02-08T00:00:00.000Z',
    sourceUrl: 'https://example.org',
    tags: [],
    createdAt: '2026-02-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('enrichOffersWithOllama', () => {
  it('setzt mindestens heuristische Marke und Ernährungs-Tags ohne LLM', async () => {
    const offers = [
      createOffer({}),
      createOffer({
        id: 'offer_tofu',
        name: 'Tofu natur',
        normalizedName: 'tofu natur',
        tags: ['vegan'],
      }),
    ];

    const enriched = await enrichOffersWithOllama(offers, false);
    expect(enriched.warnings).toHaveLength(0);
    expect(enriched.offers[0].brand).toBe('Aldi Eigenmarke');
    expect(enriched.offers[0].tags).toContain('bio');
    expect(enriched.offers[0].tags).toContain('vegan');
    expect(enriched.offers[0].tags).toContain('laktosefrei');
  });
});
