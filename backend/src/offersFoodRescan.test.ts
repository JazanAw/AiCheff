import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Offer } from '../../src/types/models';
import { ollamaChat } from '../../src/services/ollama';
import { rescanOffersWithAiFoodClassifier } from './offersFoodRescan';

vi.mock('../../src/services/ollama', () => ({
  ollamaChat: vi.fn(),
}));

function createOffer(overrides: Partial<Offer>): Offer {
  return {
    id: 'offer_test',
    name: 'Bio Bananen',
    normalizedName: 'bio bananen',
    storeChain: 'REWE',
    category: 'Obst/Gemuese',
    price: 1.99,
    currency: 'EUR',
    unit: 'kg',
    validityStart: '2026-02-08T23:00:00.000Z',
    validityEnd: '2026-02-14T22:59:59.000Z',
    sourceUrl: 'https://example.org',
    tags: ['bio'],
    createdAt: '2026-02-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('rescanOffersWithAiFoodClassifier', () => {
  beforeEach(() => {
    vi.mocked(ollamaChat).mockReset();
  });

  it('nutzt regelbasierten fallback wenn tryOllama=false', async () => {
    const offers = [
      createOffer({
        id: 'food_1',
        name: 'Vollkornbrot',
        normalizedName: 'vollkornbrot',
        category: 'Backwaren',
      }),
      createOffer({
        id: 'non_food_1',
        name: 'Kaffeemaschine',
        normalizedName: 'kaffeemaschine',
        category: 'Technik',
        tags: [],
      }),
    ];

    const result = await rescanOffersWithAiFoodClassifier(offers, false);

    expect(result.scannedCount).toBe(2);
    expect(result.aiClassifiedCount).toBe(0);
    expect(result.fallbackCount).toBe(2);
    expect(result.offers).toHaveLength(1);
    expect(result.filteredOffers).toHaveLength(1);
  });

  it('blockt KI-Food-Treffer, wenn der harte Non-Food-Filter greift', async () => {
    vi.mocked(ollamaChat).mockResolvedValueOnce(
      JSON.stringify({
        items: [
          {
            id: 'non_food_1',
            isFood: true,
          },
        ],
      }),
    );

    const offers = [
      createOffer({
        id: 'non_food_1',
        name: 'Sensodyne Zahncreme',
        normalizedName: 'sensodyne zahncreme',
        category: 'Drogerie',
        tags: [],
      }),
    ];

    const result = await rescanOffersWithAiFoodClassifier(offers, true);

    expect(result.scannedCount).toBe(1);
    expect(result.aiClassifiedCount).toBe(1);
    expect(result.offers).toHaveLength(0);
    expect(result.filteredOffers).toHaveLength(1);
    expect(result.filteredOffers[0].id).toBe('non_food_1');
    expect(
      result.warnings.some((warning) =>
        warning.includes('harten Nicht-Lebensmittel-Filter'),
      ),
    ).toBe(true);
  });
});
